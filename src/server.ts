import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { State } from "./state.js";
import type { Router } from "./router.js";
import { parseForm, verifyTwilioSignature } from "./twilio.js";
import { log } from "./log.js";

/**
 * Three routes, no framework:
 *   POST /twilio/whatsapp  the Twilio webhook (signature-verified, acked at once)
 *   POST /send             local: text the operator(s). `dispatch send` uses it.
 *   GET  /health           liveness + what is running
 */
const MAX_BODY = 1 << 20;
const SEND_WINDOW_MS = 60_000;
const SEND_MAX_PER_WINDOW = 20;

export interface ServerDeps {
  config: Config;
  state: State;
  router: Router;
  sendToOperators: (text: string, to?: string) => Promise<void>;
}

export function createDispatchServer(deps: ServerDeps): Server {
  const { config } = deps;
  const sendWindow: number[] = [];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, ...deps.router.snapshot() });
      }
      if (req.method === "POST" && url.pathname === config.webhookPath) {
        return await webhook(req, res);
      }
      if (req.method === "POST" && url.pathname === "/send") {
        return await send(req, res);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      log.error("request failed", { err: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    }
  });

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const signature = header(req, "x-twilio-signature");
    if (!signature) return json(res, 403, { error: "missing signature" });
    const body = await readBody(req);
    if (body === null) return json(res, 413, { error: "body too large" });
    const params = parseForm(body);
    // Twilio signs the public URL it was configured with, not what we see behind the proxy.
    const signedUrl = config.publicUrl + config.webhookPath;
    if (!verifyTwilioSignature(config.twilio.authToken, signedUrl, params, signature)) {
      log.warn("bad twilio signature", { from: params.From });
      return json(res, 403, { error: "bad signature" });
    }
    // Ack now (Twilio retries after 15s of silence), work after.
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    deps.router.handleWebhook(params).catch((e) => log.error("webhook handling failed", { err: String(e) }));
  }

  async function send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = header(req, "authorization") ?? "";
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(deps.state.localToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return json(res, 401, { error: "unauthorized" });
    }
    const now = Date.now();
    while (sendWindow.length && now - sendWindow[0]! > SEND_WINDOW_MS) sendWindow.shift();
    if (sendWindow.length >= SEND_MAX_PER_WINDOW) return json(res, 429, { error: "rate limited" });
    const body = await readBody(req);
    if (body === null) return json(res, 413, { error: "body too large" });
    let parsed: { text?: unknown; to?: unknown };
    try {
      parsed = JSON.parse(body) as { text?: unknown; to?: unknown };
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return json(res, 400, { error: "text required" });
    const to = typeof parsed.to === "string" ? parsed.to : undefined;
    if (to && !config.operators.includes(to)) return json(res, 400, { error: "to must be an operator" });
    sendWindow.push(now);
    await deps.sendToOperators(text.slice(0, 4000), to);
    json(res, 200, { ok: true });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
