import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, ConfigError, ENV_TEMPLATE, defaultStateDir, parseEnvFile } from "./config.js";

const USAGE = `dispatch - text your server.

  dispatch init                    write ~/.dispatch/env (then fill it in)
  dispatch start                   run the daemon
  dispatch send "text"             text the operator from any script (or: cmd | dispatch send)
  dispatch alert "text"            same, tagged with the Claude Code session it was run from
  dispatch sessions                terminal Claude Code sessions on this box the operator can steer
  dispatch tell <target> "text"    run an instruction inside one of those sessions
                                   target: folder name, path, session id prefix, or "latest"
                                   --bg (return at once, result is texted) --fork --resume --timeout <min>
  dispatch hook                    Claude Code hook entry point (reads the hook JSON on stdin)
  dispatch status                  what the running daemon is doing
  dispatch doctor                  check logins, config, Twilio, public URL
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
    case "alert":
      return alert(rest);
    case "sessions":
      return sessions();
    case "tell":
      return tell(rest);
    case "hook":
      return hook();
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
  // Heavy imports live here so `dispatch hook` (run on every prompt) stays fast.
  const [{ State }, { Sessions }, { Router }, { createDispatchServer }, { ClaudeWorker }, { CodexWorker }, twilio, { renderForWhatsApp }, { log }] =
    await Promise.all([
      import("./state.js"),
      import("./sessions.js"),
      import("./router.js"),
      import("./server.js"),
      import("./workers/claude.js"),
      import("./workers/codex.js"),
      import("./twilio.js"),
      import("./wa-format.js"),
      import("./log.js"),
    ]);
  const { sendWhatsApp, sendWhatsAppTemplate, downloadMedia, forwardWebhook, TwilioSendError } = twilio;

  const config = loadConfig();
  const state = new State(config.stateDir);
  const sessions = new Sessions(config.stateDir);
  const creds = config.twilio;

  // WhatsApp only lets a business message someone freely for 24h after their
  // last message. Past that only an approved template gets through, and the
  // rejection is asynchronous (the API says 200, the status callback says
  // 63016). So: pick the template up front when the window is clearly closed,
  // and resend via template when a status callback reports 63016 anyway.
  const WINDOW_MS = 23 * 60 * 60 * 1000;
  const statusCallback = config.publicUrl + config.statusPath;
  const recentOutbound = new Map<string, { to: string; text: string; template: boolean }>();
  const remember = (sid: string, entry: { to: string; text: string; template: boolean }) => {
    if (!sid) return;
    recentOutbound.set(sid, entry);
    if (recentOutbound.size > 300) recentOutbound.delete(recentOutbound.keys().next().value!);
  };
  const windowOpen = (to: string): boolean => {
    const last = state.operator(to, { worker: config.defaultWorker, cwd: config.workspace }).lastInboundAt;
    return Boolean(last) && Date.now() - Date.parse(last!) < WINDOW_MS;
  };
  const viaTemplate = async (to: string, text: string): Promise<void> => {
    if (!config.alertTemplateSid) throw new TwilioSendError("outside the 24h window and no DISPATCH_ALERT_TEMPLATE_SID", 0, 63016);
    // Template variables cannot hold newlines; flatten. The operator texting back reopens the window.
    const flat = text.replace(/\s*\n+\s*/g, " / ").replace(/\s{4,}/g, "   ").slice(0, 1000);
    const { sid } = await sendWhatsAppTemplate(creds, config.twilio.from, to, config.alertTemplateSid, { "1": config.machineName, "2": flat }, { statusCallback });
    remember(sid, { to, text, template: true });
    log.info("sent via template (outside 24h window)", { to, sid });
  };

  const send = async (to: string, text: string): Promise<void> => {
    for (const part of renderForWhatsApp(text)) {
      if (!windowOpen(to) && config.alertTemplateSid) {
        await viaTemplate(to, part);
        continue;
      }
      try {
        const { sid } = await sendWhatsApp(creds, config.twilio.from, to, part, { statusCallback });
        remember(sid, { to, text: part, template: false });
      } catch (e) {
        if (e instanceof TwilioSendError && e.outsideWindow) {
          if (!config.alertTemplateSid) {
            log.warn("outside WhatsApp 24h window and no DISPATCH_ALERT_TEMPLATE_SID; operator must text first", { to });
            return;
          }
          await viaTemplate(to, part);
          continue;
        }
        throw e;
      }
    }
  };

  const onStatus = async (params: Record<string, string>): Promise<void> => {
    const sid = params.MessageSid ?? params.SmsSid ?? "";
    const st = params.MessageStatus ?? "";
    if (st !== "failed" && st !== "undelivered") return;
    const code = Number(params.ErrorCode ?? "0");
    const known = recentOutbound.get(sid);
    log.warn("outbound message not delivered", { sid, status: st, code, to: params.To, template: known?.template ?? null });
    if (code === 63016 && known && !known.template && config.alertTemplateSid) {
      recentOutbound.delete(sid);
      await viaTemplate(known.to, known.text);
    }
  };

  const router = new Router({
    config,
    state,
    sessions,
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
    onStatus,
  });

  server.listen(config.port, config.host, () => {
    log.info("dispatch up", {
      bind: `${config.host}:${config.port}`,
      webhook: config.publicUrl + config.webhookPath,
      operators: config.operators.length,
      worker: config.defaultWorker,
      permissions: config.permissions,
      fallthrough: Boolean(config.fallthrough),
      alertTemplate: Boolean(config.alertTemplateSid),
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

async function call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; json: Record<string, unknown> }> {
  const { base, token } = local();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, json: parsed };
}

function textFrom(args: string[], usage: string): string {
  let text = args.join(" ").trim();
  if (!text && !process.stdin.isTTY) text = readFileSync(0, "utf8").trim();
  if (!text) {
    process.stderr.write(usage + "\n");
    process.exit(2);
  }
  return text;
}

async function send(args: string[]): Promise<void> {
  const text = textFrom(args, 'usage: dispatch send "text"   (or: cmd | dispatch send)');
  const { status, json } = await call("/send", { text });
  if (status !== 200) {
    process.stderr.write(`dispatch send: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  process.stdout.write("sent\n");
}

async function alert(args: string[]): Promise<void> {
  const text = textFrom(args, 'usage: dispatch alert "text"   (or: cmd | dispatch alert)');
  const { status, json } = await call("/alert", { text, cwd: process.cwd(), pid: process.pid });
  if (status !== 200) {
    process.stderr.write(`dispatch alert: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  const sid = typeof json.sessionId === "string" ? json.sessionId.slice(0, 8) : "no session";
  process.stdout.write(`sent (${sid}, ${typeof json.cwd === "string" ? basename(json.cwd) : "no folder"})\n`);
}

async function sessions(): Promise<void> {
  const { status, json } = await call("/sessions");
  if (status !== 200) {
    process.stderr.write(`dispatch sessions: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  const list = (json.sessions as Array<Record<string, unknown>>) ?? [];
  if (!list.length) {
    process.stdout.write("no live terminal sessions registered (hooks installed?)\n");
    return;
  }
  for (const s of list) {
    const id = String(s.id);
    const line = [
      id.slice(0, 8),
      String(s.state).padEnd(5),
      String(s.cwd),
      s.lastPrompt ? `"${String(s.lastPrompt).slice(0, 60)}"` : "",
      s.takenFor ? `(taken: ${String(s.takenFor).slice(0, 40)})` : "",
      `updated ${String(s.updatedAt).slice(0, 16).replace("T", " ")}`,
    ]
      .filter(Boolean)
      .join("  ");
    process.stdout.write(line + "\n");
  }
}

async function tell(args: string[]): Promise<void> {
  let bg = false;
  let mode: "fork" | "resume" | undefined;
  let timeoutMin = 10;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--bg") bg = true;
    else if (a === "--fork") mode = "fork";
    else if (a === "--resume") mode = "resume";
    else if (a === "--timeout") timeoutMin = Number(args[++i] ?? "10") || 10;
    else positional.push(a);
  }
  const [target, ...restWords] = positional;
  let instruction = restWords.join(" ").trim();
  if (!instruction && !process.stdin.isTTY) instruction = readFileSync(0, "utf8").trim();
  if (!target || !instruction) {
    process.stderr.write('usage: dispatch tell <folder|session-id|latest> "instruction" [--bg] [--fork|--resume] [--timeout <min>]\n');
    process.exit(2);
  }
  const { status, json } = await call("/tell", { target, instruction, waitMs: bg ? 0 : timeoutMin * 60_000, mode });
  if (status === 409) {
    process.stderr.write(`dispatch tell: ${String(json.error)}\n`);
    const cands = (json.candidates as Array<Record<string, unknown>>) ?? [];
    for (const c of cands) process.stderr.write(`  ${String(c.id).slice(0, 8)}  ${String(c.state)}  ${String(c.cwd)}\n`);
    process.exit(3);
  }
  if (status >= 300) {
    process.stderr.write(`dispatch tell: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  const where = `${basename(String(json.cwd))} (${String(json.session).slice(0, 8)})`;
  if (json.done) {
    process.stdout.write(`[${where}, ${String(json.mode)}, ${Math.round(Number(json.ms) / 1000)}s]\n${String(json.text)}\n`);
    process.exit(json.ok ? 0 : 1);
  }
  process.stdout.write(
    json.stillRunning
      ? `still running in ${where} after ${timeoutMin} min; the result will be texted to the operator when it finishes.\n`
      : `started in ${where}; the result will be texted to the operator when it finishes.\n`,
  );
}

/**
 * Claude Code hook. Registered for SessionStart, UserPromptSubmit, Stop and
 * SessionEnd in ~/.claude/settings.json. Must be silent (stdout is fed back
 * into the session for some events) and must never fail the hook.
 */
async function hook(): Promise<void> {
  try {
    const raw = readFileSync(0, "utf8");
    const input = JSON.parse(raw) as import("./sessions.js").HookInput;
    const { Sessions } = await import("./sessions.js");
    new Sessions(defaultStateDir()).applyHook(input);
  } catch {
    // never block Claude Code
  }
  process.exit(0);
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

  const settings = join(process.env.HOME ?? "", ".claude", "settings.json");
  try {
    const text = existsSync(settings) ? readFileSync(settings, "utf8") : "";
    if (/dispatch(\.js)?\s+hook/.test(text)) ok("claude code hooks", "sessions are registered for `dispatch tell`");
    else bad("claude code hooks", `no "dispatch hook" in ${settings}; see README, Steering other sessions`);
  } catch (e) {
    bad("claude code hooks", e instanceof Error ? e.message : String(e));
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
