import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Registry of the Claude Code sessions running on this box, so the operator
 * can steer any of them from the phone. Claude Code hooks (`dispatch hook`)
 * write one JSON file per session here; nothing else is needed, so the hooks
 * keep working even when the daemon is down.
 *
 *   SessionStart      -> idle (file created)
 *   UserPromptSubmit  -> busy
 *   Stop              -> idle
 *   SessionEnd        -> ended
 *
 * `taken` means dispatch stopped the terminal process and continued the
 * session headlessly; `claude --resume <id>` in a terminal picks it back up.
 */
export type SessionState = "idle" | "busy" | "ended" | "taken";

export interface SessionRecord {
  id: string;
  cwd: string;
  /** Pid of the claude CLI process (0 when it could not be determined). */
  pid: number;
  transcriptPath?: string;
  state: SessionState;
  startedAt: string;
  updatedAt: string;
  /** First line of the last prompt the operator typed, for the listing. */
  lastPrompt?: string;
  /** Set when dispatch took the session over: what it was told and when. */
  takenAt?: string;
  takenFor?: string;
  /** If a headless run continued under a new id (fork), where it went. */
  continuedAs?: string;
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  source?: string;
  reason?: string;
}

const ENDED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class Sessions {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "sessions");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    return join(this.dir, id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
  }

  get(id: string): SessionRecord | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as SessionRecord;
    } catch {
      return undefined;
    }
  }

  put(rec: SessionRecord): void {
    const f = this.file(rec.id);
    const tmp = f + ".tmp";
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    renameSync(tmp, f);
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    const next = { ...rec, ...patch, updatedAt: new Date().toISOString() };
    this.put(next);
    return next;
  }

  /**
   * Apply a Claude Code hook payload. Called from the hook process itself, so
   * the claude pid is found by walking up from our own process.
   */
  applyHook(input: HookInput, selfPid = process.pid): SessionRecord | undefined {
    const id = input.session_id;
    if (!id) return undefined;
    const now = new Date().toISOString();
    const existing = this.get(id);
    const event = input.hook_event_name ?? "";
    let state: SessionState = existing?.state ?? "idle";
    if (event === "SessionStart") state = "idle";
    else if (event === "UserPromptSubmit") state = "busy";
    else if (event === "Stop") state = "idle";
    else if (event === "SessionEnd") state = "ended";
    const pid = findClaudePid(selfPid) ?? existing?.pid ?? 0;
    const rec: SessionRecord = {
      id,
      cwd: input.cwd ?? existing?.cwd ?? process.cwd(),
      pid,
      transcriptPath: input.transcript_path ?? existing?.transcriptPath,
      state,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      lastPrompt: event === "UserPromptSubmit" && input.prompt ? firstLine(input.prompt) : existing?.lastPrompt,
      takenAt: event === "SessionStart" ? undefined : existing?.takenAt,
      takenFor: event === "SessionStart" ? undefined : existing?.takenFor,
      continuedAs: existing?.continuedAs,
    };
    this.put(rec);
    return rec;
  }

  /** All sessions, freshest first. Dead processes are marked ended; old ended ones are dropped. */
  list(opts: { exclude?: string[]; includeEnded?: boolean } = {}): SessionRecord[] {
    const out: SessionRecord[] = [];
    const now = Date.now();
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      let rec: SessionRecord;
      try {
        rec = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as SessionRecord;
      } catch {
        continue;
      }
      if (opts.exclude?.includes(rec.id)) continue;
      if ((rec.state === "idle" || rec.state === "busy") && rec.pid && !alive(rec.pid)) {
        rec = { ...rec, state: "ended", updatedAt: new Date().toISOString() };
        this.put(rec);
      }
      if (rec.state === "ended" && now - Date.parse(rec.updatedAt) > ENDED_TTL_MS) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          // best effort
        }
        continue;
      }
      if (rec.state === "ended" && !opts.includeEnded) continue;
      out.push(rec);
    }
    return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /** The session a process belongs to, by walking its ancestors for a registered claude pid. */
  forPid(pid: number, exclude?: string[]): SessionRecord | undefined {
    const chain = new Set(ancestors(pid));
    chain.add(pid);
    const live = this.list({ exclude, includeEnded: true });
    return live.find((r) => r.pid && chain.has(r.pid));
  }

  /**
   * Resolve what the operator meant by a target: a session id (or prefix), a
   * folder path, a folder basename, or "latest". Returns every candidate so
   * the caller can refuse to guess when there is more than one.
   */
  resolve(ref: string, exclude?: string[]): SessionRecord[] {
    const live = this.list({ exclude });
    const r = ref.trim();
    if (!r || r === "latest" || r === "last") return live.slice(0, 1);
    const byId = live.filter((s) => s.id === r || s.id.startsWith(r));
    if (byId.length) return byId;
    const norm = r.replace(/\/+$/, "");
    const byPath = live.filter((s) => s.cwd === norm || s.cwd.replace(/\/+$/, "") === norm);
    if (byPath.length) return byPath;
    const byBase = live.filter((s) => basename(s.cwd).toLowerCase() === basename(norm).toLowerCase());
    if (byBase.length) return byBase;
    return live.filter((s) => s.cwd.toLowerCase().includes(norm.toLowerCase()));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parent pids of `pid`, nearest first, from /proc. Linux only; empty elsewhere. */
export function ancestors(pid: number): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const ppid = parentPid(cur);
    if (!ppid || ppid <= 1) break;
    out.push(ppid);
    cur = ppid;
  }
  return out;
}

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid ..." and comm may contain spaces or parens.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(after[1]);
  } catch {
    return undefined;
  }
}

export function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

/** Nearest ancestor that is the claude CLI (hooks run as: claude -> sh -> dispatch hook). */
export function findClaudePid(from: number): number | undefined {
  for (const pid of ancestors(from)) {
    const cmd = cmdline(pid);
    if (/(^|[\s/])claude(\s|$)/.test(cmd) && !/dispatch/.test(cmd)) return pid;
  }
  return undefined;
}

/** SIGTERM, wait, SIGKILL. Resolves true when the process is gone. */
export async function stopProcess(pid: number, graceMs = 10_000): Promise<boolean> {
  if (!pid || !alive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !alive(pid);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await sleep(300);
  return !alive(pid);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function firstLine(s: string): string {
  return s.split("\n")[0]!.trim().slice(0, 120);
}
