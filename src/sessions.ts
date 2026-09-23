import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFile, execFileSync } from "node:child_process";

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
 *
 * The hooks are the fast path. `claude agents --json` (the CLI's own list of
 * interactive and background sessions, with pids) is the source of truth for
 * liveness and for telling a `claude --bg` daemon session from a terminal one;
 * it is merged in on every listing. A record is only "ended" when neither the
 * process nor the CLI knows the session any more.
 */
export type SessionState = "idle" | "busy" | "ended" | "taken";
export type SessionKind = "interactive" | "background";

/** One row of `claude agents --json`. */
export interface AgentInfo {
  sessionId: string;
  kind: SessionKind;
  cwd: string;
  pid?: number;
  /** Short id `claude stop` / `claude attach` take (background sessions). */
  id?: string;
  name?: string;
  status?: string;
  state?: string;
}

export type AgentsProvider = () => AgentInfo[];

export interface SessionRecord {
  id: string;
  cwd: string;
  /** Terminal session, or a `claude --bg` session under the daemon. */
  kind?: SessionKind;
  /** Short id the daemon uses for a background session (`claude stop <bgId>`). */
  bgId?: string;
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
const AGENTS_CACHE_MS = 3000;

export class Sessions {
  readonly dir: string;
  private agentsProvider: AgentsProvider;
  private agentsCache: { at: number; list: AgentInfo[] } | undefined;

  constructor(
    stateDir: string,
    opts: { agents?: AgentsProvider } = {},
  ) {
    this.dir = join(stateDir, "sessions");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.agentsProvider = opts.agents ?? claudeAgents;
  }

  /** What the claude CLI itself says is running (cached briefly; never throws). */
  agents(): AgentInfo[] {
    const now = Date.now();
    if (this.agentsCache && now - this.agentsCache.at < AGENTS_CACHE_MS) return this.agentsCache.list;
    let list: AgentInfo[] = [];
    try {
      list = this.agentsProvider();
    } catch {
      list = this.agentsCache?.list ?? [];
    }
    this.agentsCache = { at: now, list };
    return list;
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
    const claude = findClaudeProcess(selfPid);
    // A headless run started by dispatch itself (the Agent SDK's bundled CLI)
    // also fires these hooks. It must not make the record look like a terminal
    // session, and its exit must not mark the session ended: the transcript is
    // still there and resumable. Such records stay "taken".
    const headless = claude?.headless ?? false;
    let state: SessionState = existing?.state ?? "idle";
    if (headless) {
      state = event === "UserPromptSubmit" ? "busy" : "taken";
    } else if (event === "SessionStart") state = "idle";
    else if (event === "UserPromptSubmit") state = "busy";
    else if (event === "Stop") state = "idle";
    else if (event === "SessionEnd") state = "ended";
    const pid = headless ? 0 : (claude?.pid ?? existing?.pid ?? 0);
    const rec: SessionRecord = {
      id,
      cwd: input.cwd ?? existing?.cwd ?? process.cwd(),
      kind: headless ? existing?.kind : (claude?.kind ?? existing?.kind),
      bgId: existing?.bgId,
      pid,
      transcriptPath: input.transcript_path ?? existing?.transcriptPath,
      state,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      lastPrompt: event === "UserPromptSubmit" && input.prompt ? firstLine(input.prompt) : existing?.lastPrompt,
      takenAt: event === "SessionStart" && !headless ? undefined : existing?.takenAt,
      takenFor: event === "SessionStart" && !headless ? undefined : existing?.takenFor,
      continuedAs: existing?.continuedAs,
    };
    this.put(rec);
    return rec;
  }

  /**
   * All sessions, freshest first, reconciled with `claude agents --json`:
   * sessions the CLI knows get its kind, pid and busy/idle; sessions it started
   * before the hooks were installed are added; a record only becomes "ended"
   * when its process is gone AND the CLI no longer lists it. Old ended records
   * are dropped.
   */
  list(opts: { exclude?: string[]; includeEnded?: boolean } = {}): SessionRecord[] {
    const out: SessionRecord[] = [];
    const now = Date.now();
    const agents = new Map(this.agents().map((a) => [a.sessionId, a] as const));
    const seen = new Set<string>();
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      let rec: SessionRecord;
      try {
        rec = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as SessionRecord;
      } catch {
        continue;
      }
      seen.add(rec.id);
      const agent = agents.get(rec.id);
      const before = JSON.stringify(rec);
      if (agent) {
        rec = reconcile(rec, agent);
      } else if ((rec.state === "idle" || rec.state === "busy") && (!rec.pid || !alive(rec.pid))) {
        rec = { ...rec, state: "ended", updatedAt: new Date().toISOString() };
      }
      if (JSON.stringify(rec) !== before) this.put(rec);
      if (rec.state === "ended" && now - Date.parse(rec.updatedAt) > ENDED_TTL_MS) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          // best effort
        }
        continue;
      }
      if (opts.exclude?.includes(rec.id)) continue;
      if (rec.state === "ended" && !opts.includeEnded) continue;
      out.push(rec);
    }
    for (const a of agents.values()) {
      if (seen.has(a.sessionId) || !a.sessionId) continue;
      const ts = new Date().toISOString();
      const rec = reconcile({ id: a.sessionId, cwd: a.cwd, pid: 0, state: "idle", startedAt: ts, updatedAt: ts }, a);
      this.put(rec);
      if (opts.exclude?.includes(rec.id)) continue;
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
   * folder path, a folder basename, or "latest". Live sessions win; if nothing
   * live matches, ended sessions are searched too, because their transcripts
   * are still resumable (there is just no process to stop). Returns every
   * candidate so the caller can refuse to guess when there is more than one.
   */
  resolve(ref: string, exclude?: string[]): SessionRecord[] {
    const all = this.list({ exclude, includeEnded: true });
    const live = all.filter((s) => s.state !== "ended");
    const r = ref.trim();
    if (!r || r === "latest" || r === "last") return live.slice(0, 1);
    return matchRef(live, r).length ? matchRef(live, r) : matchRef(all, r);
  }

  /**
   * Stop a `claude --bg` session through the daemon (its conversation is kept)
   * and wait until the CLI no longer lists it. Throws with the CLI's own error
   * text when it cannot.
   */
  async stopBackground(rec: SessionRecord, graceMs = 15_000): Promise<void> {
    const ref = rec.bgId ?? rec.id.slice(0, 8);
    await new Promise<void>((resolve, reject) => {
      execFile("claude", ["stop", ref], { timeout: graceMs, env: cleanEnv() }, (err, stdout, stderr) => {
        if (err) reject(new Error(`claude stop ${ref} failed: ${String(stderr || stdout || err.message).trim()}`));
        else resolve();
      });
    });
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      this.agentsCache = undefined;
      const still = this.agents().find((a) => a.sessionId === rec.id);
      if (!still) {
        if (rec.pid) await stopProcess(rec.pid, 3000);
        return;
      }
      await sleep(500);
    }
    throw new Error(`claude stop ${ref} returned but the daemon still lists the session as running`);
  }
}

function matchRef(list: SessionRecord[], r: string): SessionRecord[] {
  const byId = list.filter((s) => s.id === r || s.id.startsWith(r) || s.bgId === r);
  if (byId.length) return byId;
  const norm = r.replace(/\/+$/, "");
  const byPath = list.filter((s) => s.cwd.replace(/\/+$/, "") === norm);
  if (byPath.length) return byPath;
  const byBase = list.filter((s) => basename(s.cwd).toLowerCase() === basename(norm).toLowerCase());
  if (byBase.length) return byBase;
  return list.filter((s) => s.cwd.toLowerCase().includes(norm.toLowerCase()));
}

/** Fold what the CLI knows about a session into its record. */
function reconcile(rec: SessionRecord, a: AgentInfo): SessionRecord {
  const busy = a.status === "busy" || a.state === "working";
  const livePid = rec.pid && alive(rec.pid) ? rec.pid : (a.pid ?? 0);
  const state: SessionState = rec.state === "taken" && !a.pid ? "taken" : busy ? "busy" : "idle";
  const changed = rec.kind !== a.kind || rec.bgId !== a.id || rec.pid !== livePid || rec.state !== state;
  return {
    ...rec,
    kind: a.kind,
    bgId: a.kind === "background" ? a.id : rec.bgId,
    pid: livePid,
    state,
    cwd: rec.cwd || a.cwd,
    updatedAt: changed ? new Date().toISOString() : rec.updatedAt,
  };
}

/** `claude agents --json`, normalised. */
export function claudeAgents(): AgentInfo[] {
  const raw = execFileSync("claude", ["agents", "--json"], { encoding: "utf8", timeout: 8000, env: cleanEnv() });
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  return parsed
    .filter((r) => typeof r.sessionId === "string")
    .map((r) => ({
      sessionId: String(r.sessionId),
      kind: r.kind === "background" ? "background" : "interactive",
      cwd: typeof r.cwd === "string" ? r.cwd : "",
      pid: typeof r.pid === "number" ? r.pid : undefined,
      id: typeof r.id === "string" ? r.id : undefined,
      name: typeof r.name === "string" ? r.name : undefined,
      status: typeof r.status === "string" ? r.status : undefined,
      state: typeof r.state === "string" ? r.state : undefined,
    }));
}

/** The claude CLI refuses to nest inside a Claude Code session; the hook and the daemon calls run from one. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
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

export interface ClaudeProcess {
  pid: number;
  kind: SessionKind;
  /** Spawned by the Agent SDK (dispatch's own headless runs), not a user session. */
  headless: boolean;
}

/**
 * Nearest ancestor that is a claude session process. Terminal sessions are a
 * bare `claude` (or `.../bin/claude.exe`); `claude --bg` sessions run as
 * `claude.exe --bg-spare ...` under a `--bg-pty-host` under `claude daemon run`;
 * dispatch's own runs are the SDK's bundled `claude-agent-sdk-linux-x64/claude`.
 * Hooks run as claude -> sh -> dispatch hook, so we walk up from ourselves.
 */
export function findClaudeProcess(from: number): ClaudeProcess | undefined {
  for (const pid of ancestors(from)) {
    const cmd = cmdline(pid);
    const [bin = "", ...args] = cmd.split(" ");
    const base = basename(bin);
    if (base !== "claude" && base !== "claude.exe") continue;
    if (args[0] === "daemon" || args[0] === "--bg-pty-host") continue; // infrastructure, not a session
    if (/dispatch/.test(cmd)) continue;
    return {
      pid,
      kind: args.includes("--bg-spare") ? "background" : "interactive",
      headless: /claude-agent-sdk/.test(bin),
    };
  }
  return undefined;
}

export function findClaudePid(from: number): number | undefined {
  return findClaudeProcess(from)?.pid;
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

/** Model names dispatch and the CLI use interchangeably ("opus" vs "claude-opus-5"). */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/** "claude-fable-5-1", "fable" and "fable[1m]" all mean the same family: "fable". */
export function modelFamily(model: string): string | undefined {
  const s = model.toLowerCase();
  return MODEL_FAMILIES.find((f) => s.includes(f));
}

/** Whether two model names mean the same model, comparing aliases against full ids. */
export function sameModel(a: string, b: string): boolean {
  const fa = modelFamily(a);
  const fb = modelFamily(b);
  if (fa && fb) return fa === fb;
  return norm(a) === norm(b);
}

function norm(m: string): string {
  return m.toLowerCase().replace(/^claude-/, "").replace(/\[1m\]$/, "");
}

/**
 * The model a session's transcript last ran on, e.g. "claude-fable-5-1". Only
 * the tail of the jsonl is read: these files reach hundreds of megabytes, and
 * the last model line is the one that matters. Never throws.
 */
export function transcriptModel(path: string | undefined, tailBytes = 256 * 1024): string | undefined {
  if (!path) return undefined;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return undefined;
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    let last: string | undefined;
    const re = /"model"\s*:\s*"(claude-[^"]+)"/g;
    for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
    return last;
  } catch {
    return undefined; // no transcript, unreadable, or not ours to read
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}
