import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig, ConfigError, defaultStateDir, parseEnvFile } from "./config.js";

const USAGE = `dispatch - text your server.

  dispatch init                    guided setup: Twilio, your number, webhook, hooks, service
                                   non-interactive: --sid AC.. --token .. --from +1.. --operator +1..
                                   [--url https://host|tunnel] [--yes] [--no-service] [--no-hooks] [--no-webhook]
  dispatch start                   run the daemon in the foreground
  dispatch service install         run it as a service (systemd user unit / launchd), also: uninstall, status, logs
  dispatch send "text"             text the operator from any script (or: cmd | dispatch send)
  dispatch alert "text"            same, tagged with the Claude Code session it was run from
  dispatch sessions                terminal Claude Code sessions on this box the operator can steer
  dispatch tell <target> "text"    run an instruction inside one of those sessions
                                   target: folder name, path, session id prefix, or "latest"
                                   --bg (return at once, result is texted) --fork --resume --timeout <min>
                                   --model <name> (default: DISPATCH_CLAUDE_MODEL)
  dispatch spawn <folder> "task"   start a fresh Claude Code session in a folder for a subtask
                                   --bg (return at once, result is texted) --timeout <min> --model <name>
                                   the session stays registered: dispatch tell <folder> continues it
  dispatch hook                    Claude Code hook entry point (reads the hook JSON on stdin)
  dispatch status                  what the running daemon is doing
  dispatch doctor                  check logins, config, Twilio, webhook, public URL
  dispatch enable-codex            install the optional Codex worker (/codex)
  dispatch --version
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "start":
      return start();
    case "init":
      return (await import("./init.js")).init(rest);
    case "service":
      return service(rest);
    case "send":
      return send(rest);
    case "alert":
      return alert(rest);
    case "sessions":
      return sessions();
    case "tell":
      return tell(rest);
    case "spawn":
      return spawn(rest);
    case "hook":
      return hook();
    case "status":
      return status();
    case "doctor":
      return doctor();
    case "enable-codex":
      return enableCodex();
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version + "\n");
      return;
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

async function start(): Promise<void> {
  // Heavy imports live here so `dispatch hook` (run on every prompt) stays fast.
  const [{ State }, { Sessions }, { Router }, { createDispatchServer }, { ClaudeWorker }, codex, twilio, { renderForWhatsApp }, { log }] =
    await Promise.all([
      import("./state.js"),
      import("./sessions.js"),
      import("./router.js"),
      import("./server.js"),
      import("./workers/claude.js"),
      // Codex is optional (its SDK is ~300MB): `dispatch enable-codex` installs it.
      import("./workers/codex.js").catch(() => undefined),
      import("./twilio.js"),
      import("./wa-format.js"),
      import("./log.js"),
    ]);
  const { sendWhatsApp, sendWhatsAppTemplate, downloadMedia, forwardWebhook, TwilioSendError } = twilio;

  const config = loadConfig();
  if (config.allowRoot) process.env.DISPATCH_ALLOW_ROOT = "1"; // read by the claude worker
  const state = new State(config.stateDir);
  const sessions = new Sessions(config.stateDir);
  const creds = config.twilio;

  // WhatsApp only lets a business message someone freely for 24h after their
  // last message. Past that only an approved template gets through, and the
  // rejection is asynchronous (the API says 200, the status callback says
  // 63016). So: pick the template up front when the window is clearly closed,
  // and resend via template when a status callback reports 63016 anyway.
  const WINDOW_MS = 23 * 60 * 60 * 1000;
  // Read at send time: with a tunnel the public URL is only known after startup.
  const statusCallback = () => (config.publicUrl ? config.publicUrl + config.statusPath : undefined);
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
    const { sid } = await sendWhatsAppTemplate(creds, config.twilio.from, to, config.alertTemplateSid, { "1": config.machineName, "2": flat }, { statusCallback: statusCallback() });
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
        const { sid } = await sendWhatsApp(creds, config.twilio.from, to, part, { statusCallback: statusCallback() });
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
    workers: { claude: new ClaudeWorker(), codex: codex ? new codex.CodexWorker() : missingCodex() },
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

  // Twilio must know where to post. With a tunnel the URL is new on every
  // start (and every tunnel restart), so it is re-pointed each time.
  const { pointWebhook } = await import("./twilio-admin.js");
  const wire = async (): Promise<void> => {
    if (!config.autoWebhook || !config.publicUrl) return;
    const url = config.publicUrl + config.webhookPath;
    try {
      const r = await pointWebhook(creds, config.twilio.from, url, { statusUrl: config.publicUrl + config.statusPath, allowShared: config.sharedService });
      log.info(r.changed ? "twilio webhook pointed here" : "twilio webhook already points here", { via: r.what, url, previous: r.previous || null });
    } catch (e) {
      log.error("could not point the twilio webhook; set it by hand", { url, err: e instanceof Error ? e.message : String(e) });
    }
  };

  let tunnelChild: import("node:child_process").ChildProcess | undefined;
  let stopping = false;
  const runTunnel = async (attempt = 0): Promise<void> => {
    const { ensureCloudflared, startTunnel, waitReachable } = await import("./tunnel.js");
    try {
      const bin = await ensureCloudflared(config.stateDir);
      const t = await startTunnel(bin, config.port);
      tunnelChild = t.child;
      config.publicUrl = t.url;
      writeFileSync(join(config.stateDir, "public-url"), t.url + "\n");
      log.info("tunnel up", { url: t.url });
      if (!(await waitReachable(t.url))) log.warn("tunnel URL not reachable yet; twilio may fail until it is", { url: t.url });
      await wire();
      t.child.once("exit", (code) => {
        if (stopping) return;
        log.warn("tunnel exited, restarting", { code });
        setTimeout(() => void runTunnel(), 2000);
      });
    } catch (e) {
      const wait = Math.min(60_000, 2000 * 2 ** attempt);
      log.error("tunnel failed", { err: e instanceof Error ? e.message : String(e), retryInMs: wait });
      if (!stopping) setTimeout(() => void runTunnel(attempt + 1), wait);
    }
  };

  server.listen(config.port, config.host, () => {
    if (config.tunnel) void runTunnel();
    else void wire();
    log.info("dispatch up", {
      bind: `${config.host}:${config.port}`,
      webhook: config.tunnel ? "(tunnel, URL follows)" : config.publicUrl + config.webhookPath,
      operators: config.operators.length,
      worker: config.defaultWorker,
      permissions: config.permissions,
      fallthrough: Boolean(config.fallthrough),
      alertTemplate: Boolean(config.alertTemplateSid),
    });
  });

  const shutdown = () => {
    stopping = true;
    tunnelChild?.kill();
    log.info("dispatch shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function missingCodex(): import("./workers/types.js").Worker {
  return {
    name: "codex",
    run: async () => ({ text: "codex is not installed on this box. run `dispatch enable-codex` there (and log in with `codex login`), or /claude to switch back." }),
  };
}

/** Install the optional Codex SDK next to dispatch itself. */
function enableCodex(): void {
  const root = packageRoot();
  process.stdout.write(`installing @openai/codex-sdk into ${root} (about 300MB)...\n`);
  try {
    execFileSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", "@openai/codex-sdk@^0.153.4"], { cwd: root, stdio: "inherit" });
  } catch {
    process.stderr.write(`failed. if dispatch was installed with sudo, rerun this with sudo.\n`);
    process.exit(1);
  }
  process.stdout.write("done. log in with `codex login`, restart dispatch, then text /codex.\n");
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function service(args: string[]): Promise<void> {
  const svc = await import("./service.js");
  switch (args[0]) {
    case "install":
      loadConfig(); // refuse to install something that cannot start
      process.exit(svc.installService() ? 0 : 1);
    case "uninstall":
      return svc.uninstallService();
    case "status":
      return svc.serviceStatus();
    case "logs":
      return svc.serviceLogs();
    default:
      process.stderr.write("usage: dispatch service install|uninstall|status|logs\n");
      process.exit(2);
  }
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
      s.kind === "background" ? `bg:${String(s.bgId ?? id.slice(0, 8))}` : "term",
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
  let model: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--bg") bg = true;
    else if (a === "--fork") mode = "fork";
    else if (a === "--resume") mode = "resume";
    else if (a === "--timeout") timeoutMin = Number(args[++i] ?? "10") || 10;
    else if (a === "--model") model = args[++i];
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else positional.push(a);
  }
  const [target, ...restWords] = positional;
  let instruction = restWords.join(" ").trim();
  if (!instruction && !process.stdin.isTTY) instruction = readFileSync(0, "utf8").trim();
  if (!target || !instruction) {
    process.stderr.write('usage: dispatch tell <folder|session-id|latest> "instruction" [--bg] [--fork|--resume] [--timeout <min>] [--model <name>]\n');
    process.exit(2);
  }
  const { status, json } = await call("/tell", { target, instruction, waitMs: bg ? 0 : timeoutMin * 60_000, mode, model });
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
    const note = typeof json.note === "string" && json.note ? `\nnote: ${json.note}` : "";
    const on = typeof json.model === "string" && json.model ? `, ${json.model}` : "";
    process.stdout.write(`[${where}, ${String(json.mode)}${on}, ${Math.round(Number(json.ms) / 1000)}s${json.ok ? "" : ", FAILED"}]\n${String(json.text)}${note}\n`);
    process.exit(json.ok ? 0 : 1);
  }
  process.stdout.write(
    json.stillRunning
      ? `still running in ${where} after ${timeoutMin} min; the result will be texted to the operator when it finishes.\n`
      : `started in ${where}; the result will be texted to the operator when it finishes.\n`,
  );
}

async function spawn(args: string[]): Promise<void> {
  let bg = false;
  let timeoutMin = 30;
  let model: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--bg") bg = true;
    else if (a === "--timeout") timeoutMin = Number(args[++i] ?? "30") || 30;
    else if (a === "--model") model = args[++i];
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else positional.push(a);
  }
  const [folder, ...restWords] = positional;
  let instruction = restWords.join(" ").trim();
  if (!instruction && !process.stdin.isTTY) instruction = readFileSync(0, "utf8").trim();
  if (!folder || !instruction) {
    process.stderr.write('usage: dispatch spawn <folder> "task" [--bg] [--timeout <min>] [--model <name>]\n');
    process.exit(2);
  }
  // Relative folders are relative to where the command runs, not the daemon's workspace.
  const abs = folder.startsWith("/") || folder.startsWith("~") ? folder : join(process.cwd(), folder);
  const { status, json } = await call("/spawn", { folder: abs, instruction, waitMs: bg ? 0 : timeoutMin * 60_000, model });
  if (status >= 300) {
    process.stderr.write(`dispatch spawn: ${String(json.error ?? JSON.stringify(json))}\n`);
    process.exit(status === 409 ? 3 : 1);
  }
  const where = basename(String(json.cwd));
  if (json.done) {
    const sid = typeof json.session === "string" ? json.session.slice(0, 8) : "?";
    process.stdout.write(`[${where}, new session ${sid}, ${Math.round(Number(json.ms) / 1000)}s${json.ok ? "" : ", FAILED"}]\n${String(json.text)}\n`);
    process.exit(json.ok ? 0 : 1);
  }
  process.stdout.write(
    json.stillRunning
      ? `still running in ${where} after ${timeoutMin} min; the result will be texted to the operator when it finishes.\n`
      : `started a new session in ${where}; the result will be texted to the operator when it finishes.\n`,
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
  const { status, json } = await call("/health");
  if (status !== 200) {
    process.stderr.write(`dispatch status: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(json, null, 2) + "\n");
}

async function doctor(): Promise<void> {
  let failed = false;
  const ok = (label: string, detail = "") => process.stdout.write(`  ok    ${label}${detail ? "  " + detail : ""}\n`);
  const warn = (label: string, detail = "") => process.stdout.write(`  warn  ${label}${detail ? "  " + detail : ""}\n`);
  const bad = (label: string, detail = "") => {
    failed = true;
    process.stdout.write(`  FAIL  ${label}${detail ? "  " + detail : ""}\n`);
  };

  let config;
  try {
    config = loadConfig();
    ok("config", config.envFile);
  } catch (e) {
    bad("config", `${e instanceof Error ? e.message : String(e)} (run: dispatch init)`);
    process.exit(1);
  }

  if (process.getuid?.() === 0) {
    if (config.allowRoot) warn("running as root", "DISPATCH_ALLOW_ROOT is set; the agent has root");
    else bad("running as root", "Claude Code will not take full permissions as root. use a normal user (the installer creates one), or set DISPATCH_ALLOW_ROOT=1");
  }

  const { claudeBin, claudeLoggedIn } = await import("./init.js");
  const login = claudeLoggedIn(claudeBin());
  if (login.ok) ok("claude login", login.who ?? "");
  else bad("claude login", "not logged in: claude auth login (or set ANTHROPIC_API_KEY)");

  try {
    await import("./workers/codex.js");
    ok("codex", "installed (/codex)");
  } catch {
    ok("codex", "not installed (optional: dispatch enable-codex)");
  }

  const admin = await import("./twilio-admin.js");
  let credsOk = false;
  try {
    const acct = await admin.checkCredentials(config.twilio);
    ok("twilio credentials", `account "${acct.name}"`);
    credsOk = true;
  } catch (e) {
    bad("twilio credentials", e instanceof Error ? e.message : String(e));
  }

  // With a tunnel, the URL is whatever the running daemon last got.
  let publicUrl = config.publicUrl;
  if (config.tunnel) {
    const f = join(config.stateDir, "public-url");
    publicUrl = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    if (!publicUrl) warn("tunnel", "no tunnel URL yet: is the daemon running? (dispatch start)");
  }

  if (publicUrl) {
    try {
      const res = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) ok("public url", `${publicUrl}/health`);
      else bad("public url", `${publicUrl}/health -> HTTP ${res.status} (is the daemon running behind the proxy?)`);
    } catch (e) {
      bad("public url", `${publicUrl}/health unreachable (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (credsOk) {
    try {
      const r = await admin.routing(config.twilio, config.twilio.from);
      const want = publicUrl ? publicUrl + config.webhookPath : "";
      const where = r.via === "service" ? `Messaging Service "${r.service?.name}"` : `sender ${config.twilio.from}`;
      if (r.via === "unknown") bad("whatsapp sender", `${config.twilio.from} is not a WhatsApp sender on this account`);
      else if (want && r.effectiveUrl === want) ok("twilio webhook", `${where} -> ${want}`);
      else if (config.twilio.from === admin.SANDBOX_ADDRESS)
        warn("twilio webhook", `sandbox shows ${r.effectiveUrl || "nothing"}; make sure "when a message comes in" at ${admin.SANDBOX_CONSOLE} is ${want || "<public url>/twilio/whatsapp"}`);
      else bad("twilio webhook", `${where} -> ${r.effectiveUrl || "nothing"}, expected ${want || "<public url>/twilio/whatsapp"}${config.autoWebhook ? " (restart dispatch to re-point it)" : " (set DISPATCH_AUTO_WEBHOOK=true, or set it in the Twilio console)"}`);
    } catch (e) {
      warn("twilio webhook", `could not read routing: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const { base } = local();
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) ok("daemon", `running on ${base}`);
    else bad("daemon", `${base}/health -> HTTP ${res.status}`);
  } catch {
    warn("daemon", "not running (dispatch start, or dispatch service install)");
  }

  const settings = join(process.env.HOME ?? "", ".claude", "settings.json");
  try {
    const text = existsSync(settings) ? readFileSync(settings, "utf8") : "";
    if (/(dispatch|cli\.js)\s+hook/.test(text)) ok("claude code hooks", "terminal sessions are registered for dispatch tell");
    else warn("claude code hooks", "not installed (optional; needed only to steer terminal sessions). dispatch init adds them");
  } catch (e) {
    warn("claude code hooks", e instanceof Error ? e.message : String(e));
  }

  process.stdout.write(failed ? "\nfix the FAIL lines above.\n" : "\nall good. text the number.\n");
  process.exit(failed ? 1 : 0);
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ConfigError) process.stderr.write(`config: ${e.message}\n`);
  else process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
