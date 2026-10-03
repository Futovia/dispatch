import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/**
 * Dispatch is configured by ONE env file (default ~/.dispatch/env) plus the
 * process environment. No JSON config, no CLI flags to remember: every knob is
 * a DISPATCH_* variable, listed in `dispatch init`.
 */
export type WorkerName = "claude" | "codex";
export type ChannelName = "whatsapp" | "imessage";
export type PermissionPolicy = "auto" | "ask";

export interface Config {
  /** How operators reach the box. iMessage needs a Mac signed in to Messages. */
  channels: ChannelName[];
  stateDir: string;
  envFile: string;
  host: string;
  port: number;
  /** Public https origin Twilio posts to, e.g. https://dispatch.example.com. With a tunnel, filled in at startup. */
  publicUrl: string;
  /** DISPATCH_PUBLIC_URL=tunnel: run a Cloudflare quick tunnel instead of needing a hostname. */
  tunnel: boolean;
  /** Point the Twilio sender's inbound webhook at publicUrl on every start. */
  autoWebhook: boolean;
  /** The sender's Messaging Service is shared with other numbers and may be repointed anyway. */
  sharedService: boolean;
  /** Let the agent run with full permissions as root (Claude Code refuses otherwise). */
  allowRoot: boolean;
  /** Path Twilio posts to (under publicUrl). */
  webhookPath: string;
  /** Path Twilio posts delivery statuses to (under publicUrl). */
  statusPath: string;
  /** Present when the whatsapp channel is on. */
  twilio?: { accountSid: string; authToken: string; from: string };
  /**
   * The operators, by id: "whatsapp:+15551234567" for a phone number (the key
   * dispatch has always used, whatever channel they text on), "imessage:me@x.com"
   * for an operator known only by an Apple ID email.
   */
  operators: string[];
  /**
   * Every address allowed to drive the box, mapped to its operator id. One person
   * texting on WhatsApp from +1555... and on iMessage from me@icloud.com is one
   * operator: one conversation, one session, one history.
   */
  aliases: Record<string, string>;
  /** iMessage: Messages' database (overridable for tests) and how often to look at it. */
  imessage?: { dbPath: string; pollMs: number };
  workspace: string;
  defaultWorker: WorkerName;
  permissions: PermissionPolicy;
  claudeModel?: string;
  codexModel?: string;
  maxTurns: number;
  jobTimeoutMs: number;
  approvalTimeoutMs: number;
  /** Quiet period after an operator's last text before the batch runs; each new text restarts it. 0 = run at once. */
  debounceMs: number;
  /** Where non-operator webhooks go (re-signed), if anywhere. */
  fallthrough?: { url: string; signedUrl: string; command?: string };
  /** Twilio Content template used for alerts outside the 24h window ({{1}} machine, {{2}} text). */
  alertTemplateSid?: string;
  /** How long `dispatch tell` waits for a busy session to go idle before forking instead. */
  tellIdleWaitMs: number;
  /** Ceiling for a headless run started by `dispatch tell` or `dispatch spawn`. */
  tellTimeoutMs: number;
  /** How many `dispatch spawn` sessions may run at once. */
  maxSpawns: number;
  fallthroughReply?: string;
  /** Label for the machine in the agent's system prompt. */
  machineName: string;
}

export class ConfigError extends Error {}

export function defaultStateDir(): string {
  return process.env.DISPATCH_STATE_DIR ?? join(homedir(), ".dispatch");
}

/** Parse a KEY=VALUE env file without a dependency. Quotes are stripped, # comments skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** An Apple ID email or a phone number, as Messages records the sender: "me@x.com", "+15551234567". */
export function normalizeHandle(input: string): string {
  const s = input.trim().replace(/^imessage:/i, "");
  if (s.includes("@")) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ConfigError(`not an email address: ${input}`);
    return s.toLowerCase();
  }
  const digits = s.replace(/[^0-9]/g, "");
  if (!digits) throw new ConfigError(`not a phone number or email: ${input}`);
  return `+${digits}`;
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Operator ids and the alias table. DISPATCH_OPERATORS lists people (a phone
 * number, or with iMessage an Apple ID email); DISPATCH_IMESSAGE_OPERATORS adds
 * the iMessage handles they text from, each "handle" or "handle=<operator>".
 */
export function resolveOperators(
  channels: ChannelName[],
  operatorsVar: string | undefined,
  imessageVar: string | undefined,
): { operators: string[]; aliases: Record<string, string> } {
  const imessage = channels.includes("imessage");
  const whatsapp = channels.includes("whatsapp");
  const operators: string[] = [];
  const aliases: Record<string, string> = {};
  const idFor = (entry: string): string => {
    const h = normalizeHandle(entry);
    if (h.includes("@")) {
      if (!imessage) throw new ConfigError(`${entry}: an email can only be an operator with the imessage channel on`);
      return `imessage:${h}`;
    }
    return `whatsapp:${h}`;
  };
  for (const entry of list(operatorsVar)) {
    const id = idFor(entry);
    if (operators.includes(id)) continue;
    operators.push(id);
    const handle = id.slice(id.indexOf(":") + 1);
    if (id.startsWith("whatsapp:") && whatsapp) aliases[id] = id;
    if (imessage) aliases[`imessage:${handle}`] = id;
  }
  if (!operators.length) throw new ConfigError("DISPATCH_OPERATORS must list at least one phone number (or, with iMessage, an Apple ID email)");
  for (const entry of list(imessageVar)) {
    if (!imessage) break;
    const [rawHandle, rawOwner] = entry.split("=").map((s) => s.trim());
    const handle = normalizeHandle(rawHandle!);
    let owner: string | undefined;
    if (rawOwner) {
      owner = idFor(rawOwner);
      if (!operators.includes(owner)) throw new ConfigError(`DISPATCH_IMESSAGE_OPERATORS: ${rawOwner} is not in DISPATCH_OPERATORS`);
    } else {
      owner = aliases[`imessage:${handle}`] ?? (operators.length === 1 ? operators[0] : undefined);
      if (!owner) throw new ConfigError(`DISPATCH_IMESSAGE_OPERATORS: say whose handle ${handle} is, e.g. ${handle}=+15551234567`);
    }
    aliases[`imessage:${handle}`] = owner;
  }
  return { operators, aliases };
}

/** "whatsapp:+1 (555) 123-4567" / "+15551234567" / "15551234567" -> "whatsapp:+15551234567" */
export function normalizeAddress(input: string): string {
  const digits = input.replace(/[^0-9]/g, "");
  if (!digits) throw new ConfigError(`not a phone number: ${input}`);
  return `whatsapp:+${digits}`;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`expected a number, got ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.DISPATCH_STATE_DIR ?? join(homedir(), ".dispatch");
  const envFile = env.DISPATCH_ENV ?? join(stateDir, "env");
  const merged: Record<string, string | undefined> = { ...(env as Record<string, string | undefined>) };
  if (existsSync(envFile)) {
    const fromFile = parseEnvFile(readFileSync(envFile, "utf8"));
    for (const [k, v] of Object.entries(fromFile)) if (merged[k] === undefined) merged[k] = v;
  }

  const need = (k: string): string => {
    const v = merged[k];
    if (!v) throw new ConfigError(`${k} is required (set it in ${envFile})`);
    return v;
  };

  const channels = [...new Set(list(merged.DISPATCH_CHANNELS || "whatsapp").map((c) => c.toLowerCase()))] as ChannelName[];
  for (const c of channels) if (c !== "whatsapp" && c !== "imessage") throw new ConfigError(`DISPATCH_CHANNELS: unknown channel ${c} (whatsapp, imessage)`);
  if (!channels.length) throw new ConfigError("DISPATCH_CHANNELS must name at least one of: whatsapp, imessage");
  const whatsapp = channels.includes("whatsapp");
  if (channels.includes("imessage") && (env.DISPATCH_PLATFORM ?? process.platform) !== "darwin") {
    throw new ConfigError("the imessage channel needs macOS (a Mac signed in to Messages)");
  }

  const { operators, aliases } = resolveOperators(channels, need("DISPATCH_OPERATORS"), merged.DISPATCH_IMESSAGE_OPERATORS);

  // Twilio, the public URL and the webhook only matter for WhatsApp.
  const rawUrl = whatsapp ? need("DISPATCH_PUBLIC_URL").replace(/\/+$/, "") : "";
  const tunnel = rawUrl === "tunnel";
  const publicUrl = tunnel ? "" : rawUrl;
  if (whatsapp && !tunnel && !/^https:\/\//.test(publicUrl)) throw new ConfigError("DISPATCH_PUBLIC_URL must be an https origin, or: tunnel");
  const autoWebhook = whatsapp && /^(1|true|yes|on)$/i.test(merged.DISPATCH_AUTO_WEBHOOK || (tunnel ? "true" : "false"));

  const worker = (merged.DISPATCH_WORKER ?? "claude") as WorkerName;
  if (worker !== "claude" && worker !== "codex") throw new ConfigError("DISPATCH_WORKER must be claude or codex");
  const permissions = (merged.DISPATCH_PERMISSIONS ?? "auto") as PermissionPolicy;
  if (permissions !== "auto" && permissions !== "ask") throw new ConfigError("DISPATCH_PERMISSIONS must be auto or ask");

  const fallthroughUrl = merged.DISPATCH_FALLTHROUGH_URL;
  const fallthrough = fallthroughUrl
    ? {
        url: fallthroughUrl,
        signedUrl: merged.DISPATCH_FALLTHROUGH_SIGNED_URL || fallthroughUrl,
        command: merged.DISPATCH_FALLTHROUGH_COMMAND ? merged.DISPATCH_FALLTHROUGH_COMMAND.replace(/^\//, "") : undefined,
      }
    : undefined;

  return {
    channels,
    stateDir,
    envFile,
    host: merged.DISPATCH_HOST || "127.0.0.1",
    port: num(merged.DISPATCH_PORT, 8790),
    publicUrl,
    tunnel,
    autoWebhook,
    sharedService: /^(1|true|yes|on)$/i.test(merged.DISPATCH_SHARED_SERVICE ?? ""),
    allowRoot: /^(1|true|yes|on)$/i.test(merged.DISPATCH_ALLOW_ROOT ?? ""),
    webhookPath: "/twilio/whatsapp",
    statusPath: "/twilio/status",
    twilio: whatsapp
      ? {
          accountSid: need("TWILIO_ACCOUNT_SID"),
          authToken: need("TWILIO_AUTH_TOKEN"),
          from: normalizeAddress(need("TWILIO_WHATSAPP_FROM")),
        }
      : undefined,
    operators,
    aliases,
    imessage: channels.includes("imessage")
      ? {
          dbPath: merged.DISPATCH_IMESSAGE_DB || join(homedir(), "Library", "Messages", "chat.db"),
          pollMs: Math.max(250, num(merged.DISPATCH_IMESSAGE_POLL_MS, 1500)),
        }
      : undefined,
    workspace: merged.DISPATCH_WORKSPACE || homedir(),
    defaultWorker: worker,
    permissions,
    claudeModel: merged.DISPATCH_CLAUDE_MODEL || undefined,
    codexModel: merged.DISPATCH_CODEX_MODEL || undefined,
    maxTurns: num(merged.DISPATCH_MAX_TURNS, 200),
    jobTimeoutMs: num(merged.DISPATCH_JOB_TIMEOUT_MIN, 60) * 60_000,
    approvalTimeoutMs: num(merged.DISPATCH_APPROVAL_TIMEOUT_MIN, 15) * 60_000,
    debounceMs: Math.max(0, num(merged.DISPATCH_DEBOUNCE_SEC, 60)) * 1000,
    fallthrough,
    fallthroughReply: merged.DISPATCH_FALLTHROUGH_REPLY || undefined,
    alertTemplateSid: merged.DISPATCH_ALERT_TEMPLATE_SID || undefined,
    tellIdleWaitMs: num(merged.DISPATCH_TELL_IDLE_WAIT_SEC, 90) * 1000,
    tellTimeoutMs: num(merged.DISPATCH_TELL_TIMEOUT_MIN, 30) * 60_000,
    maxSpawns: num(merged.DISPATCH_MAX_SPAWNS, 4),
    machineName: merged.DISPATCH_MACHINE_NAME || hostname(),
  };
}

/** The env template `dispatch init` writes. Doubles as the config reference. */
export const ENV_TEMPLATE = `# dispatch - text your server. Every setting lives here.

# How you text this box: whatsapp, imessage, or whatsapp,imessage.
# imessage needs this to be a Mac signed in to Messages, ideally with its own Apple ID.
DISPATCH_CHANNELS=whatsapp

# Twilio (WhatsApp sender). Only needed for whatsapp. Console -> Messaging -> Senders -> WhatsApp senders.
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Who may drive this box. Comma-separated phone numbers (with iMessage, an Apple ID
# email works too). Everyone else is ignored (or forwarded, see DISPATCH_FALLTHROUGH_URL).
DISPATCH_OPERATORS=+15551234567

# iMessage: the phone numbers and Apple ID emails you text this Mac from, if not
# just the numbers above. With one operator, every handle here is that operator;
# with several, write handle=operator (me@icloud.com=+15551234567). WhatsApp and
# iMessage from the same operator are one conversation; replies go where you last texted from.
DISPATCH_IMESSAGE_OPERATORS=

# WhatsApp only: public https origin Twilio can reach, e.g. https://dispatch.example.com behind
# your reverse proxy. Or: tunnel (a free Cloudflare quick tunnel, no domain needed;
# its URL changes on every restart, so keep DISPATCH_AUTO_WEBHOOK=true with it).
DISPATCH_PUBLIC_URL=tunnel

# Point the WhatsApp sender's inbound webhook at <public url>/twilio/whatsapp on
# every start. Default: true with a tunnel, false with your own URL.
DISPATCH_AUTO_WEBHOOK=

# Where the agent works by default. /cd changes it per operator.
DISPATCH_WORKSPACE=${homedir()}

# claude | codex. /claude and /codex switch at runtime.
DISPATCH_WORKER=claude

# auto: the agent has your box. ask: every write or command is a yes/no on your phone.
DISPATCH_PERMISSIONS=auto

# Optional. Leave blank for each CLI's default model.
DISPATCH_CLAUDE_MODEL=
DISPATCH_CODEX_MODEL=

# Optional. Bind address and port for the local http server (behind your reverse proxy).
DISPATCH_HOST=127.0.0.1
DISPATCH_PORT=8790

# Optional. Non-operator webhooks are re-signed and POSTed here (e.g. the bot that
# used to own this number). DISPATCH_FALLTHROUGH_SIGNED_URL is the URL that service
# validates the Twilio signature against (defaults to the URL itself).
# Optional: let operators reach that bot too, with /<command> <message>. Blank = no such command.
DISPATCH_FALLTHROUGH_URL=
DISPATCH_FALLTHROUGH_SIGNED_URL=
DISPATCH_FALLTHROUGH_COMMAND=
# Or, with no fallthrough, a fixed reply for strangers (blank = silence).
DISPATCH_FALLTHROUGH_REPLY=

# Optional. A Twilio Content template (approved for WhatsApp) with two variables:
# {{1}} machine name, {{2}} message. Used only when an alert falls outside the
# 24h reply window, which plain messages cannot cross.
DISPATCH_ALERT_TEMPLATE_SID=

# Optional. How many dispatch spawn sessions may run at once.
DISPATCH_MAX_SPAWNS=4

# Optional. dispatch tell waits this long for a busy terminal session to finish
# its turn before forking it instead of stopping it; and caps the headless run.
DISPATCH_TELL_IDLE_WAIT_SEC=90
DISPATCH_TELL_TIMEOUT_MIN=30

# Wait this many seconds after your last text before starting, so a burst of texts
# runs as one task. Every new text restarts the wait. Send /go to skip it, 0 = off.
DISPATCH_DEBOUNCE_SEC=60

# Optional limits.
DISPATCH_MAX_TURNS=200
DISPATCH_JOB_TIMEOUT_MIN=60
DISPATCH_APPROVAL_TIMEOUT_MIN=15
DISPATCH_LOG_LEVEL=info
`;
