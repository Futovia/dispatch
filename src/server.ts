import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { State } from "./state.js";
import type { Router } from "./router.js";
import { parseForm, verifyTwilioSignature } from "./twilio.js";
import { log } from "./log.js";

import { TellError } from "./router.js";

/**
 * A handful of routes, no framework:
 *   POST /twilio/whatsapp  the Twilio webhook (signature-verified, acked at once)
 *   POST /twilio/status    Twilio delivery statuses for what we sent (signature-verified)
 *   POST /send             local: text the operator(s). `dispatch send` uses it.
 *   POST /alert            local: text the operator, tagged with the calling session. `dispatch alert` / ping-admin.
 *   POST /tell             local: run an instruction inside another terminal session. `dispatch tell`.
 *   GET  /sessions         local: the terminal sessions the hooks registered.
 *   GET  /health           liveness + what is running
 * "local" routes need the bearer token from state.json; only same-user processes can read it.
 */
const MAX_BODY = 1 << 20;
const SEND_WINDOW_MS = 60_000;
const SEND_MAX_PER_WINDOW = 20;

export interface ServerDeps {
  config: Config;
  state: State;
  router: Router;
  sendToOperators: (text: string, to?: string) => Promise<void>;
  /** A verified delivery status callback for an outbound message. */
  onStatus: (params: Record<string, string>) => Promise<void>;
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
      if (req.method === "POST" && url.pathname === config.statusPath) {
        return await status(req, res);
      }
      if (req.method === "POST" && url.pathname === "/send") {
        return await send(req, res);
      }
      if (req.method === "POST" && url.pathname === "/alert") {
        return await alert(req, res);
      }
      if (req.method === "POST" && url.pathname === "/tell") {
        return await tell(req, res);
      }
      if (req.method === "GET" && url.pathname === "/sessions") {
        if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { sessions: deps.router.listSessions(), alerts: deps.state.alerts().slice(-10) });
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

  function authorized(req: IncomingMessage): boolean {
    const auth = header(req, "authorization") ?? "";
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(deps.state.localToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    const body = await readBody(req);
    if (body === null) {
      json(res, 413, { error: "body too large" });
      return null;
    }
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch {
      json(res, 400, { error: "invalid json" });
      return null;
    }
  }

  async function alert(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    const now = Date.now();
    while (sendWindow.length && now - sendWindow[0]! > SEND_WINDOW_MS) sendWindow.shift();
    if (sendWindow.length >= SEND_MAX_PER_WINDOW) return json(res, 429, { error: "rate limited" });
    const parsed = await readJson(req, res);
    if (!parsed) return;
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return json(res, 400, { error: "text required" });
    const to = typeof parsed.to === "string" ? parsed.to : undefined;
    if (to && !config.operators.includes(to)) return json(res, 400, { error: "to must be an operator" });
    sendWindow.push(now);
    const out = await deps.router.alert({
      text: text.slice(0, 4000),
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      to,
    });
    json(res, out.delivered ? 200 : 502, { ok: out.delivered, ...out });
  }

  async function tell(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    const parsed = await readJson(req, res);
    if (!parsed) return;
    const target = typeof parsed.target === "string" ? parsed.target.trim() : "";
    const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
    if (!instruction) return json(res, 400, { error: "instruction required" });
    const waitMs = typeof parsed.waitMs === "number" ? Math.max(0, parsed.waitMs) : 0;
    const force = parsed.mode === "fork" || parsed.mode === "resume" ? parsed.mode : undefined;
    const notify = parsed.notify !== false;
    let job;
    try {
      job = deps.router.tell(target || "latest", instruction, { notify, force });
    } catch (e) {
      if (e instanceof TellError) {
        return json(res, 409, { error: e.message, candidates: e.candidates.map((c) => ({ id: c.id, cwd: c.cwd, state: c.state })) });
      }
      throw e;
    }
    const started = { id: job.id, session: job.target.id, cwd: job.target.cwd };
    if (!waitMs) return json(res, 202, { ok: true, started: true, ...started });
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), waitMs));
    const outcome = await Promise.race([job.done, timer]);
    if (outcome === "timeout") return json(res, 202, { ok: true, started: true, stillRunning: true, ...started });
    json(res, 200, { ok: outcome.ok, done: true, ...started, mode: outcome.mode, text: outcome.text, ms: outcome.ms, sessionId: outcome.sessionId });
  }

  async function status(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const signature = header(req, "x-twilio-signature");
    if (!signature) return json(res, 403, { error: "missing signature" });
    const body = await readBody(req);
    if (body === null) return json(res, 413, { error: "body too large" });
    const params = parseForm(body);
    if (!verifyTwilioSignature(config.twilio.authToken, config.publicUrl + config.statusPath, params, signature)) {
      log.warn("bad twilio signature on status callback");
      return json(res, 403, { error: "bad signature" });
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    deps.onStatus(params).catch((e) => log.error("status handling failed", { err: String(e) }));
  }

  async function send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
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
