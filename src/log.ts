/**
 * One-line JSON logs on stdout. journald (or any log shipper) captures them,
 * `dispatch logs` greps them. No log library: a daemon this size does not need one.
 */
export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(process.env.DISPATCH_LOG_LEVEL as Level) ?? "info"] ?? 20;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(fields) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

/** Never let a token or auth header hit the logs, whatever a caller passes in. */
function redact(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return fields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = /token|secret|auth|key|password/i.test(k) ? "[redacted]" : v;
  }
  return out;
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
