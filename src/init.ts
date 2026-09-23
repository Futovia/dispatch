import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ENV_TEMPLATE, defaultStateDir, normalizeAddress, parseEnvFile } from "./config.js";
import { checkCredentials, listWhatsAppSenders, pointWebhook, routing, SANDBOX_ADDRESS, SANDBOX_CONSOLE, TwilioAdminError, type AdminCreds } from "./twilio-admin.js";
import { cliPath, installService } from "./service.js";

/**
 * `dispatch init`: from nothing to texting your server. Asks for (or takes as
 * flags) the Twilio credentials, the WhatsApp sender and your own number,
 * checks each one against Twilio as it goes, writes ~/.dispatch/env, points
 * the sender's webhook here, installs the Claude Code hooks and the service.
 *
 *   dispatch init --sid AC... --token ... --from +1555... --operator +1555... [--url https://host | tunnel]
 *                 [--yes] [--no-service] [--no-hooks] [--no-webhook] [--shared-service]
 */
export interface InitFlags {
  sid?: string;
  token?: string;
  from?: string;
  operator?: string;
  url?: string;
  yes: boolean;
  service: boolean;
  hooks: boolean;
  webhook: boolean;
  sharedService: boolean;
}

export function parseInitFlags(args: string[]): InitFlags {
  const f: InitFlags = { yes: false, service: true, hooks: true, webhook: true, sharedService: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [k, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const val = () => inline ?? args[++i];
    if (k === "--sid") f.sid = val();
    else if (k === "--token") f.token = val();
    else if (k === "--from") f.from = val();
    else if (k === "--operator" || k === "--to") f.operator = val();
    else if (k === "--url") f.url = val();
    else if (k === "--yes" || k === "-y") f.yes = true;
    else if (k === "--no-service") f.service = false;
    else if (k === "--no-hooks") f.hooks = false;
    else if (k === "--no-webhook") f.webhook = false;
    else if (k === "--shared-service") f.sharedService = true;
    else throw new Error(`unknown option ${a}`);
  }
  return f;
}

const out = (s = "") => process.stdout.write(s + "\n");
const step = (n: number, total: number, s: string) => out(`\n[${n}/${total}] ${s}`);

class Prompt {
  private rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  private muted = false;
  private lines: string[] = [];
  private waiters: Array<(s: string) => void> = [];

  constructor(readonly interactive: boolean) {
    const rl = this.rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s: string) => {
      if (!this.muted || /\n|\r/.test(s)) orig(s);
      else orig("*".repeat(s.length));
    };
    this.rl.on("line", (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    this.rl.on("close", () => {
      for (const w of this.waiters.splice(0)) w("");
    });
  }

  async ask(q: string, opts: { def?: string; secret?: boolean } = {}): Promise<string> {
    if (!this.interactive) return opts.def ?? "";
    const suffix = opts.def ? ` [${opts.secret ? "keep" : opts.def}]` : "";
    process.stdout.write(`  ${q}${suffix}: `);
    this.muted = Boolean(opts.secret);
    const line = this.lines.shift() ?? (await new Promise<string>((r) => this.waiters.push(r)));
    this.muted = false;
    return line.trim() || opts.def || "";
  }

  async confirm(q: string, def = true): Promise<boolean> {
    if (!this.interactive) return def;
    const a = (await this.ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
    return a ? a.startsWith("y") : def;
  }

  close(): void {
    this.rl.close();
  }
}

/** The claude CLI on PATH, or the one bundled with the Agent SDK (so a box without Claude Code still works). */
export function claudeBin(): string {
  try {
    const p = execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
    if (p) return p;
  } catch {
    // fall through
  }
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = join(pkg, "..", "claude");
    if (existsSync(bin)) return bin;
  } catch {
    // fall through
  }
  return "claude";
}

export function claudeLoggedIn(bin = claudeBin()): { ok: boolean; who?: string } {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  try {
    const raw = execFileSync(bin, ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000, env, stdio: ["ignore", "pipe", "pipe"] });
    const j = JSON.parse(raw) as { loggedIn?: boolean; email?: string; authMethod?: string };
    return { ok: Boolean(j.loggedIn), who: j.email ?? j.authMethod };
  } catch {
    // An API key in the environment works without a login.
    return { ok: Boolean(process.env.ANTHROPIC_API_KEY), who: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : undefined };
  }
}

/** Register `dispatch hook` for the four session events in ~/.claude/settings.json, keeping everything else. */
export function installHooks(file = join(homedir(), ".claude", "settings.json"), command = hookCommand()): "added" | "present" {
  let settings: Record<string, any> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    if (text) settings = JSON.parse(text) as Record<string, any>;
  }
  settings.hooks ??= {};
  let added = false;
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
    const list = (settings.hooks[ev] ??= []) as Array<{ hooks?: Array<{ command?: string }> }>;
    const has = list.some((g) => (g.hooks ?? []).some((h) => /(dispatch|cli\.js)\s+hook\b/.test(h.command ?? "")));
    if (!has) {
      list.push({ hooks: [{ type: "command", command, timeout: 5 } as { command: string }] });
      added = true;
    }
  }
  if (!added) return "present";
  mkdirSync(join(file, ".."), { recursive: true });
  if (existsSync(file)) writeFileSync(file + ".bak-dispatch", readFileSync(file));
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return "added";
}

function hookCommand(): string {
  try {
    if (execFileSync("sh", ["-c", "command -v dispatch"], { encoding: "utf8" }).trim()) return "dispatch hook";
  } catch {
    // not on PATH
  }
  return `${process.execPath} ${cliPath()} hook`;
}

/** Rewrite the env template with `values`, keeping any other setting already in `existing`. */
export function renderEnv(values: Record<string, string>, existing: Record<string, string> = {}): string {
  const merged = { ...existing, ...values };
  const seen = new Set<string>();
  const lines = ENV_TEMPLATE.split("\n").map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (!m) return line;
    seen.add(m[1]!);
    return m[1]! in merged ? `${m[1]}=${merged[m[1]!]}` : line;
  });
  const extra = Object.keys(merged).filter((k) => !seen.has(k));
  if (extra.length) lines.push("# Kept from the previous env file", ...extra.map((k) => `${k}=${merged[k]}`), "");
  return lines.join("\n");
}

export async function init(args: string[]): Promise<void> {
  const flags = parseInitFlags(args);
  const interactive = Boolean(process.stdin.isTTY) && !flags.yes;
  const p = new Prompt(interactive);
  const dir = defaultStateDir();
  const envFile = process.env.DISPATCH_ENV ?? join(dir, "env");
  const existing = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  const fail = (msg: string): never => {
    p.close();
    process.stderr.write(`\n${msg}\n`);
    process.exit(1);
  };
  const TOTAL = 6;

  out("dispatch: text your server. setup takes about two minutes.");

  // 1. Claude
  step(1, TOTAL, "Claude Code login");
  const bin = claudeBin();
  let login = claudeLoggedIn(bin);
  if (!login.ok) {
    out("  not logged in. dispatch runs Claude Code with your own subscription (or ANTHROPIC_API_KEY).");
    if (interactive && (await p.confirm("log in now?"))) {
      p.close();
      spawnSync(bin, ["auth", "login"], { stdio: "inherit" });
      login = claudeLoggedIn(bin);
      if (!login.ok) fail("still not logged in. run `claude auth login` (or set ANTHROPIC_API_KEY), then `dispatch init` again.");
      // readline was closed for the login flow; start a fresh prompt for the rest.
      return init(args);
    }
    if (!interactive) out("  continuing; log in before starting: claude auth login");
  } else out(`  ok, logged in (${login.who ?? "yes"})`);

  // 2. Twilio credentials
  step(2, TOTAL, "Twilio account (console.twilio.com, Account Info on the dashboard)");
  let sid = flags.sid ?? process.env.TWILIO_ACCOUNT_SID ?? existing.TWILIO_ACCOUNT_SID ?? "";
  let token = flags.token ?? process.env.TWILIO_AUTH_TOKEN ?? existing.TWILIO_AUTH_TOKEN ?? "";
  let creds: AdminCreds | undefined;
  for (let tries = 0; tries < 3 && !creds; tries++) {
    if (interactive && (tries > 0 || !flags.sid)) sid = await p.ask("Account SID (starts with AC)", { def: sid || undefined });
    if (interactive && (tries > 0 || !flags.token)) token = await p.ask("Auth Token", { def: token || undefined, secret: true });
    if (!/^AC[0-9a-f]{32}$/i.test(sid) || !token) {
      if (!interactive) fail("need --sid AC... and --token (or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
      out("  that does not look like an Account SID (AC + 32 hex characters) and token. again:");
      continue;
    }
    try {
      const acct = await checkCredentials({ accountSid: sid, authToken: token });
      creds = { accountSid: sid, authToken: token };
      out(`  ok, account "${acct.name}" (${acct.status})`);
    } catch (e) {
      out(`  Twilio said no: ${e instanceof Error ? e.message : String(e)}`);
      if (!interactive) fail("check --sid and --token");
    }
  }
  if (!creds) fail("could not verify the Twilio credentials");
  const c = creds!;

  // 3. WhatsApp sender
  step(3, TOTAL, "WhatsApp sender (the number you will text)");
  let senders: Awaited<ReturnType<typeof listWhatsAppSenders>> = [];
  try {
    senders = await listWhatsAppSenders(c);
  } catch (e) {
    out(`  could not list senders (${e instanceof Error ? e.message : String(e)}); type the number instead.`);
  }
  const real = senders.filter((s) => s.address !== SANDBOX_ADDRESS);
  let from = flags.from ?? existing.TWILIO_WHATSAPP_FROM ?? "";
  if (!flags.from && interactive) {
    if (senders.length) {
      senders.forEach((s, i) => out(`  ${i + 1}. ${s.address.replace("whatsapp:", "")}  ${s.address === SANDBOX_ADDRESS ? "(Twilio sandbox, for trying it out)" : s.status.toLowerCase()}`));
    }
    const def = from || real[0]?.address.replace("whatsapp:", "") || SANDBOX_ADDRESS.replace("whatsapp:", "");
    const a = await p.ask(senders.length ? "pick a number from the list, or type one" : "WhatsApp sender number", { def });
    from = /^\d{1,2}$/.test(a) && senders[Number(a) - 1] ? senders[Number(a) - 1]!.address : a;
  }
  if (!from) from = real[0]?.address ?? SANDBOX_ADDRESS;
  try {
    from = normalizeAddress(from);
  } catch {
    fail(`not a phone number: ${from}`);
  }
  const sandbox = from === SANDBOX_ADDRESS;
  if (sandbox) {
    out("  using the Twilio sandbox. from your phone, send the join code shown at");
    out(`  ${SANDBOX_CONSOLE}`);
    out("  (\"join <two-words>\") to +1 415 523 8886 before you text dispatch. it expires after 3 days of silence.");
  } else if (senders.length && !senders.some((s) => s.address === from)) {
    out(`  note: ${from} is not listed as a WhatsApp sender on this account.`);
  }
  out(`  ok, ${from}`);

  // 4. Operator
  step(4, TOTAL, "your own WhatsApp number (the only one allowed to drive this box)");
  let operator = flags.operator ?? existing.DISPATCH_OPERATORS ?? "";
  if (!flags.operator && interactive) operator = await p.ask("your number, with country code (e.g. +44 7700 900123)", { def: operator || undefined });
  let operators: string;
  try {
    operators = operator
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => normalizeAddress(s).replace("whatsapp:", ""))
      .join(",");
    if (!operators) throw new Error("empty");
  } catch {
    fail("need your WhatsApp number: --operator +15551234567");
  }
  out(`  ok, ${operators!}`);

  // 5. Public URL
  step(5, TOTAL, "how Twilio reaches this box");
  let url = flags.url ?? existing.DISPATCH_PUBLIC_URL ?? "tunnel";
  if (!flags.url && interactive) {
    out("  tunnel: a free Cloudflare tunnel, nothing to set up (its URL changes on restart; dispatch re-points Twilio itself)");
    out("  or an https URL you already route to this box (e.g. https://dispatch.example.com -> 127.0.0.1:8790)");
    url = await p.ask("tunnel or https URL", { def: url });
  }
  url = url.replace(/\/+$/, "");
  if (url !== "tunnel" && !/^https:\/\//.test(url)) fail(`must be "tunnel" or an https URL, got: ${url}`);
  const autoWebhook = flags.webhook && (url === "tunnel" || (existing.DISPATCH_AUTO_WEBHOOK ?? "true") !== "false");
  out(`  ok, ${url === "tunnel" ? "Cloudflare tunnel" : url}`);

  // Check the webhook can be pointed before anything is written, so a shared
  // Messaging Service is a question now, not a surprise on first start.
  let allowShared = flags.sharedService;
  if (autoWebhook) {
    try {
      const r = await routing(c, from);
      if (r.via === "service" && r.service && r.service.members > 1 && !allowShared) {
        out(`  ${from} is in Messaging Service "${r.service.name}" with ${r.service.members - 1} other number(s); its inbound URL (${r.service.inboundUrl || "none"}) applies to all of them.`);
        allowShared = await p.confirm("point the whole service at dispatch?", false);
      }
    } catch {
      // doctor will say more
    }
  }

  // 6. Write, wire, install
  step(6, TOTAL, "writing config and installing");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const values: Record<string, string> = {
    TWILIO_ACCOUNT_SID: c.accountSid,
    TWILIO_AUTH_TOKEN: c.authToken,
    TWILIO_WHATSAPP_FROM: from,
    DISPATCH_OPERATORS: operators!,
    DISPATCH_PUBLIC_URL: url,
    DISPATCH_AUTO_WEBHOOK: autoWebhook ? "true" : "false",
    DISPATCH_WORKSPACE: existing.DISPATCH_WORKSPACE || homedir(),
  };
  if (allowShared) values.DISPATCH_SHARED_SERVICE = "true";
  writeFileSync(envFile, renderEnv(values, existing), { mode: 0o600 });
  out(`  wrote ${envFile}`);
  const md = join(dir, "DISPATCH.md");
  if (!existsSync(md)) {
    writeFileSync(md, "# Operator instructions\n\nAnything here is appended to the agent's system prompt. House rules, persona, where things live.\n");
  }

  if (url !== "tunnel" && autoWebhook) {
    try {
      const r = await pointWebhook(c, from, `${url}/twilio/whatsapp`, { statusUrl: `${url}/twilio/status`, allowShared });
      out(r.changed ? `  pointed ${r.what} at ${url}/twilio/whatsapp (was: ${r.previous || "nothing"})` : `  ${r.what} already points at ${url}/twilio/whatsapp`);
    } catch (e) {
      out(`  could not point the webhook: ${e instanceof TwilioAdminError || e instanceof Error ? e.message : String(e)}`);
      out(`  set it by hand: ${sandbox ? SANDBOX_CONSOLE : "Twilio console -> Messaging -> Senders -> WhatsApp senders"}, "when a message comes in" = ${url}/twilio/whatsapp`);
    }
  } else if (url === "tunnel") {
    out("  the webhook is pointed at the tunnel each time dispatch starts");
  }

  if (flags.hooks && (await p.confirm("register your Claude Code sessions so dispatch can steer them (hooks in ~/.claude/settings.json)?"))) {
    try {
      out(installHooks() === "added" ? "  hooks added (backup: ~/.claude/settings.json.bak-dispatch)" : "  hooks already there");
    } catch (e) {
      out(`  could not update ~/.claude/settings.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let running = false;
  if (flags.service && (await p.confirm("run dispatch as a service now (starts on boot)?"))) running = installService((s) => out("  " + s));
  p.close();

  out("");
  if (running) {
    const ready = await waitForStart(dir, url);
    if (ready) out(`dispatch is running${ready !== true ? ` at ${ready}` : ""}.`);
    else out("dispatch was started but has not come up yet. check: dispatch service logs");
  } else out("start it with: dispatch start   (or: dispatch service install)");
  out(`\nnow text ${from.replace("whatsapp:", "")} on WhatsApp from ${operators!.split(",")[0]}: "what's on this box?"`);
  if (sandbox) out("(join the sandbox first, see step 3)");
  out("check everything with: dispatch doctor");
}

/** Wait for the local daemon (and, with a tunnel, its public URL). Returns the URL, true, or false. */
async function waitForStart(dir: string, url: string, timeoutMs = 90_000): Promise<string | boolean> {
  const envFile = process.env.DISPATCH_ENV ?? join(dir, "env");
  const env = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  const port = env.DISPATCH_PORT || "8790";
  const deadline = Date.now() + timeoutMs;
  const publicFile = join(dir, "public-url");
  const before = existsSync(publicFile) ? readFileSync(publicFile, "utf8").trim() : "";
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        if (url !== "tunnel") return url;
        if (existsSync(publicFile)) {
          const now = readFileSync(publicFile, "utf8").trim();
          // A fresh start writes a fresh URL; an old file from a previous run does not count.
          if (now && (now !== before || Date.now() - startedAt > 30_000)) return now;
        }
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
