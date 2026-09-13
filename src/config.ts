import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/**
 * Dispatch is configured by ONE env file (default ~/.dispatch/env) plus the
 * process environment. No JSON config, no CLI flags to remember: every knob is
 * a DISPATCH_* variable, listed in `dispatch init`.
 */
export type WorkerName = "claude" | "codex";
export type PermissionPolicy = "auto" | "ask";

export interface Config {
  stateDir: string;
  envFile: string;
  host: string;
  port: number;
  /** Public https origin Twilio posts to, e.g. https://dispatch.example.com */
  publicUrl: string;
  /** Path Twilio posts to (under publicUrl). */
  webhookPath: string;
  /** Path Twilio posts delivery statuses to (under publicUrl). */
  statusPath: string;
  twilio: { accountSid: string; authToken: string; from: string };
  /** WhatsApp addresses allowed to drive the box ("whatsapp:+15551234567"). */
  operators: string[];
  workspace: string;
  defaultWorker: WorkerName;
  permissions: PermissionPolicy;
  claudeModel?: string;
  codexModel?: string;
  maxTurns: number;
  jobTimeoutMs: number;
  approvalTimeoutMs: number;
  /** Where non-operator webhooks go (re-signed), if anywhere. */
  fallthrough?: { url: string; signedUrl: string; command?: string };
  /** Twilio Content template used for alerts outside the 24h window ({{1}} machine, {{2}} text). */
  alertTemplateSid?: string;
  /** How long `dispatch tell` waits for a busy session to go idle before forking instead. */
  tellIdleWaitMs: number;
  /** Ceiling for a headless run started by `dispatch tell`. */
  tellTimeoutMs: number;
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

  const operators = need("DISPATCH_OPERATORS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAddress);
  if (!operators.length) throw new ConfigError("DISPATCH_OPERATORS must list at least one phone number");

  const publicUrl = need("DISPATCH_PUBLIC_URL").replace(/\/+$/, "");
  if (!/^https:\/\//.test(publicUrl)) throw new ConfigError("DISPATCH_PUBLIC_URL must be an https origin");

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
    stateDir,
    envFile,
    host: merged.DISPATCH_HOST || "127.0.0.1",
    port: num(merged.DISPATCH_PORT, 8790),
    publicUrl,
    webhookPath: "/twilio/whatsapp",
    statusPath: "/twilio/status",
    twilio: {
      accountSid: need("TWILIO_ACCOUNT_SID"),
      authToken: need("TWILIO_AUTH_TOKEN"),
      from: normalizeAddress(need("TWILIO_WHATSAPP_FROM")),
    },
    operators,
    workspace: merged.DISPATCH_WORKSPACE || homedir(),
    defaultWorker: worker,
    permissions,
    claudeModel: merged.DISPATCH_CLAUDE_MODEL || undefined,
    codexModel: merged.DISPATCH_CODEX_MODEL || undefined,
    maxTurns: num(merged.DISPATCH_MAX_TURNS, 200),
    jobTimeoutMs: num(merged.DISPATCH_JOB_TIMEOUT_MIN, 60) * 60_000,
    approvalTimeoutMs: num(merged.DISPATCH_APPROVAL_TIMEOUT_MIN, 15) * 60_000,
    fallthrough,
    fallthroughReply: merged.DISPATCH_FALLTHROUGH_REPLY || undefined,
    alertTemplateSid: merged.DISPATCH_ALERT_TEMPLATE_SID || undefined,
    tellIdleWaitMs: num(merged.DISPATCH_TELL_IDLE_WAIT_SEC, 90) * 1000,
    tellTimeoutMs: num(merged.DISPATCH_TELL_TIMEOUT_MIN, 30) * 60_000,
    machineName: merged.DISPATCH_MACHINE_NAME || hostname(),
  };
}

/** The env template `dispatch init` writes. Doubles as the config reference. */
export const ENV_TEMPLATE = `# dispatch - text your server. Every setting lives here.

# Twilio (WhatsApp sender). Console -> Messaging -> Senders -> WhatsApp senders.
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# Who may drive this box. Comma-separated phone numbers. Everyone else is ignored
# (or forwarded, see DISPATCH_FALLTHROUGH_URL).
DISPATCH_OPERATORS=+15551234567

# Public https origin Twilio can reach. Point the sender's inbound webhook at
# <this>/twilio/whatsapp
DISPATCH_PUBLIC_URL=https://dispatch.example.com

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

# Optional. dispatch tell waits this long for a busy terminal session to finish
# its turn before forking it instead of stopping it; and caps the headless run.
DISPATCH_TELL_IDLE_WAIT_SEC=90
DISPATCH_TELL_TIMEOUT_MIN=30

# Optional limits.
DISPATCH_MAX_TURNS=200
DISPATCH_JOB_TIMEOUT_MIN=60
DISPATCH_APPROVAL_TIMEOUT_MIN=15
DISPATCH_LOG_LEVEL=info
`;
