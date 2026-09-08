import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, ConfigError, ENV_TEMPLATE, defaultStateDir, parseEnvFile } from "./config.js";
import { State } from "./state.js";
import { Router } from "./router.js";
import { createDispatchServer } from "./server.js";
import { ClaudeWorker } from "./workers/claude.js";
import { CodexWorker } from "./workers/codex.js";
import { sendWhatsApp, downloadMedia, forwardWebhook, TwilioSendError } from "./twilio.js";
import { renderForWhatsApp } from "./wa-format.js";
import { log } from "./log.js";

const USAGE = `dispatch - text your server.

  dispatch init             write ~/.dispatch/env (then fill it in)
  dispatch start            run the daemon
  dispatch send "text"      text the operator from any script (or: cmd | dispatch send)
  dispatch status           what the running daemon is doing
  dispatch doctor           check logins, config, Twilio, public URL
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "start":
      return start();
    case "init":
      return init();
    case "send":
      return send(rest);
    case "status":
      return status();
    case "doctor":
      return doctor();
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

async function start(): Promise<void> {
  const config = loadConfig();
  const state = new State(config.stateDir);
  const creds = config.twilio;

  const send = async (to: string, text: string): Promise<void> => {
    for (const part of renderForWhatsApp(text)) {
      try {
        await sendWhatsApp(creds, config.twilio.from, to, part);
      } catch (e) {
        if (e instanceof TwilioSendError && e.outsideWindow) {
          log.warn("outside WhatsApp 24h window; operator must text first", { to });
          return;
        }
        throw e;
      }
    }
  };

  const router = new Router({
    config,
    state,
    workers: { claude: new ClaudeWorker(), codex: new CodexWorker() },
    send,
    forward: async (params) => {
      if (!config.fallthrough) return;
      const { status } = await forwardWebhook(creds.authToken, config.fallthrough, params);
      if (status >= 300) log.warn("fallthrough rejected the webhook", { status });
    },
    download: (url) => downloadMedia(creds, url),
  });

  const server = createDispatchServer({
    config,
    state,
    router,
    sendToOperators: async (text, to) => {
      for (const op of to ? [to] : config.operators) await send(op, text);
    },
  });

  server.listen(config.port, config.host, () => {
    log.info("dispatch up", {
      bind: `${config.host}:${config.port}`,
      webhook: config.publicUrl + config.webhookPath,
      operators: config.operators.length,
      worker: config.defaultWorker,
      permissions: config.permissions,
      fallthrough: Boolean(config.fallthrough),
    });
  });

  const shutdown = () => {
    log.info("dispatch shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function init(): void {
  const dir = defaultStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "env");
  if (existsSync(file)) {
    process.stdout.write(`${file} already exists. edit it, then: dispatch doctor\n`);
    return;
  }
  writeFileSync(file, ENV_TEMPLATE, { mode: 0o600 });
  const md = join(dir, "DISPATCH.md");
  if (!existsSync(md)) {
    writeFileSync(
      md,
      "# Operator instructions\n\nAnything here is appended to the agent's system prompt. House rules, persona, where things live.\n",
    );
  }
  process.stdout.write(`wrote ${file}\nfill it in, then: dispatch doctor && dispatch start\n`);
}

/** Talk to the local daemon: reads the port from the env file and the token from state.json. */
function local(): { base: string; token: string } {
  const dir = defaultStateDir();
  const envFile = process.env.DISPATCH_ENV ?? join(dir, "env");
  const env = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  const host = process.env.DISPATCH_HOST ?? env.DISPATCH_HOST ?? "127.0.0.1";
  const port = process.env.DISPATCH_PORT ?? env.DISPATCH_PORT ?? "8790";
  const stateFile = join(dir, "state.json");
  if (!existsSync(stateFile)) throw new Error(`no state at ${stateFile}; is the daemon running?`);
  const token = (JSON.parse(readFileSync(stateFile, "utf8")) as { localToken: string }).localToken;
  return { base: `http://${host}:${port}`, token };
}

async function send(args: string[]): Promise<void> {
  let text = args.join(" ").trim();
  if (!text && !process.stdin.isTTY) {
    text = readFileSync(0, "utf8").trim();
  }
  if (!text) {
    process.stderr.write('usage: dispatch send "text"   (or: cmd | dispatch send)\n');
    process.exit(2);
  }
  const { base, token } = local();
  const res = await fetch(`${base}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    process.stderr.write(`dispatch send: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  process.stdout.write("sent\n");
}

async function status(): Promise<void> {
  const { base } = local();
  const res = await fetch(`${base}/health`);
  process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
}

async function doctor(): Promise<void> {
  let failed = false;
  const ok = (label: string, detail = "") => process.stdout.write(`  ok    ${label}${detail ? "  " + detail : ""}\n`);
  const bad = (label: string, detail = "") => {
    failed = true;
    process.stdout.write(`  FAIL  ${label}${detail ? "  " + detail : ""}\n`);
  };

  let config;
  try {
    config = loadConfig();
    ok("config", config.envFile);
  } catch (e) {
    bad("config", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  for (const bin of ["claude", "codex"]) {
    try {
      const v = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
      ok(bin, v.split("\n")[0]);
    } catch {
      bad(bin, "not on PATH (install it and log in)");
    }
  }

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}.json`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64"),
      },
    });
    if (res.ok) ok("twilio credentials");
    else bad("twilio credentials", `HTTP ${res.status}`);
  } catch (e) {
    bad("twilio credentials", e instanceof Error ? e.message : String(e));
  }

  try {
    const res = await fetch(`${config.publicUrl}/health`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) ok("public url", `${config.publicUrl}/health`);
    else bad("public url", `${config.publicUrl}/health -> HTTP ${res.status} (is the daemon running behind the proxy?)`);
  } catch (e) {
    bad("public url", `${config.publicUrl}/health unreachable (${e instanceof Error ? e.message : String(e)})`);
  }

  process.stdout.write(
    failed
      ? "\nfix the FAIL lines, then: dispatch start\n"
      : `\nall good. point the Twilio sender webhook at ${config.publicUrl}${config.webhookPath}\n`,
  );
  process.exit(failed ? 1 : 0);
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ConfigError) process.stderr.write(`config: ${e.message}\n`);
  else process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
