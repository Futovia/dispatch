import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, loadavg, freemem, totalmem } from "node:os";
import type { Config, WorkerName, PermissionPolicy } from "./config.js";
import type { State, OperatorState } from "./state.js";
import { Sessions, stopProcess, sleep, sameModel, transcriptModel, type SessionRecord } from "./sessions.js";
import type { Worker, ApprovalRequest, WorkerEvent } from "./workers/types.js";
import { parseInbound, type InboundMessage } from "./twilio.js";
import { buildSystemPrompt } from "./prompt.js";
import { log } from "./log.js";

/**
 * The router is the product: one operator, one conversation, one job at a
 * time. Text goes to the active worker. Slash commands steer. Strangers are
 * forwarded or ignored. Nothing here knows about http or Twilio wire formats.
 */
export interface RouterDeps {
  config: Config;
  state: State;
  sessions: Sessions;
  workers: Record<WorkerName, Worker>;
  /** Deliver text to a WhatsApp address (already formatted + chunked by the caller). */
  send: (to: string, text: string) => Promise<void>;
  /** Forward a raw webhook to the fallthrough service. */
  forward: (params: Record<string, string>) => Promise<void>;
  /** Download inbound media; returns the bytes. */
  download: (url: string) => Promise<Buffer>;
  /** Stop a `claude --bg` session through the daemon. Defaults to Sessions.stopBackground. */
  stopBackground?: (rec: SessionRecord) => Promise<void>;
  now?: () => number;
}

interface Job {
  worker: WorkerName;
  startedAt: number;
  ac: AbortController;
  prompt: string;
  sentSomething: boolean;
}

interface PendingApproval {
  req: ApprovalRequest;
  resolve: (ok: boolean) => void;
}

/** A headless run dispatch started on someone else's session (`dispatch tell`). */
export interface TellJob {
  id: string;
  target: SessionRecord;
  instruction: string;
  startedAt: number;
  ac: AbortController;
  mode: "resume" | "fork";
  /** Model this run is pinned to; undefined means the CLI default decides. */
  model?: string;
  done: Promise<TellResult>;
}

export interface TellResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  mode: "resume" | "fork";
  ms: number;
  /** Model the run was pinned to, or undefined when the CLI default decided. */
  model?: string;
  /** Why it forked or failed, for the operator. */
  note?: string;
}

export interface TellOptions {
  notify?: boolean;
  force?: "resume" | "fork";
  /** Override the configured model for this one instruction. */
  model?: string;
}

/** A fresh headless Claude session dispatch started for a subtask (`dispatch spawn`). */
export interface SpawnJob {
  id: string;
  cwd: string;
  instruction: string;
  startedAt: number;
  ac: AbortController;
  model?: string;
  /** Set once the SDK reports the new session id. */
  sessionId?: string;
  /** Text the result to the operator when done. A waiting caller that gives up flips this on. */
  notify: boolean;
  done: Promise<SpawnResult>;
}

export interface SpawnResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  ms: number;
  model?: string;
}

export interface SpawnOptions {
  notify?: boolean;
  model?: string;
}

export class TellError extends Error {
  constructor(
    message: string,
    readonly candidates: SessionRecord[] = [],
  ) {
    super(message);
  }
}

const COMMANDS = ["help", "new", "claude", "codex", "cd", "status", "stop", "verbose", "yes", "no", "auto", "ask"];
const STRANGER_COOLDOWN_MS = 60 * 60 * 1000;
const SLOW_NOTICE_MS = 45_000;

export class Router {
  private jobs = new Map<string, Job>();
  private queued = new Map<string, InboundMessage[]>();
  private approvals = new Map<string, PendingApproval>();
  private strangerRepliedAt = new Map<string, number>();
  private permissionOverride = new Map<string, PermissionPolicy>();
  private tells = new Map<string, TellJob>();
  private tellSeq = 0;
  private spawns = new Map<string, SpawnJob>();
  private spawnSeq = 0;
  readonly startedAt: number;

  constructor(private deps: RouterDeps) {
    this.startedAt = this.now();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Public snapshot for /health and /status. */
  snapshot() {
    return {
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      jobs: [...this.jobs.entries()].map(([op, j]) => ({
        operator: op,
        worker: j.worker,
        elapsedSec: Math.round((this.now() - j.startedAt) / 1000),
      })),
      queued: [...this.queued.entries()].map(([op, q]) => ({ operator: op, count: q.length })),
      tells: [...this.tells.values()].map((t) => ({
        id: t.id,
        session: t.target.id,
        cwd: t.target.cwd,
        mode: t.mode,
        elapsedSec: Math.round((this.now() - t.startedAt) / 1000),
      })),
      spawns: [...this.spawns.values()].map((j) => ({
        id: j.id,
        session: j.sessionId ?? null,
        cwd: j.cwd,
        elapsedSec: Math.round((this.now() - j.startedAt) / 1000),
      })),
    };
  }

  /** Terminal sessions the operator can steer: everything the hooks registered except our own. */
  listSessions(): SessionRecord[] {
    return this.deps.sessions.list({ exclude: this.deps.state.ownSessionIds() });
  }

  /** Entry point for a verified Twilio webhook body. Never throws. */
  async handleWebhook(params: Record<string, string>): Promise<void> {
    const msg = parseInbound(params);
    if (!msg) return; // a status callback or something else we do not care about
    if (!this.deps.state.markSeen(msg.sid)) {
      log.debug("duplicate webhook ignored", { sid: msg.sid });
      return;
    }
    if (!this.deps.config.operators.includes(msg.from)) return this.stranger(params, msg);

    this.deps.state.transcript(msg.from, { dir: "in", text: msg.body, media: msg.media.map((m) => m.contentType) });
    const op = this.operator(msg.from);
    this.deps.state.update(msg.from, { lastInboundAt: new Date(this.now()).toISOString() });

    const text = msg.body.trim();
    const cmd = this.parseCommand(text);
    if (cmd) return this.command(msg.from, op, cmd.name, cmd.rest, params);

    const pending = this.approvals.get(msg.from);
    if (pending && /^(y|yes|yep|ok|go|sure|n|no|nope|deny)\.?$/i.test(text)) {
      return this.answerApproval(msg.from, /^(y|yes|yep|ok|go|sure)/i.test(text));
    }

    if (!text && !msg.media.length) return;

    if (this.jobs.has(msg.from)) {
      const q = this.queued.get(msg.from) ?? [];
      q.push(msg);
      this.queued.set(msg.from, q);
      if (q.length === 1) await this.say(msg.from, "got it, queued behind the current task. /stop to cancel that one.");
      return;
    }
    void this.run(msg.from, [msg]);
  }

  private operator(address: string): OperatorState {
    return this.deps.state.operator(address, {
      worker: this.deps.config.defaultWorker,
      cwd: this.deps.config.workspace,
    });
  }

  private permissions(address: string): PermissionPolicy {
    return this.permissionOverride.get(address) ?? this.deps.config.permissions;
  }

  private parseCommand(text: string): { name: string; rest: string } | null {
    if (!text.startsWith("/")) return null;
    const m = /^\/([a-zA-Z]+)\b\s*([\s\S]*)$/.exec(text);
    if (!m) return null;
    const name = m[1]!.toLowerCase();
    const known = COMMANDS.includes(name) || name === this.deps.config.fallthrough?.command;
    return known ? { name, rest: m[2]!.trim() } : null; // "/etc/hosts is broken" goes to the agent
  }

  private async command(
    from: string,
    op: OperatorState,
    name: string,
    rest: string,
    params: Record<string, string>,
  ): Promise<void> {
    const { config, state } = this.deps;
    if (name === config.fallthrough?.command) {
      if (!rest) return this.say(from, `usage: /${name} <message>`);
      await this.deps.forward({ ...params, Body: rest });
      return;
    }
    switch (name) {
      case "help":
        return this.say(from, this.helpText());
      case "new": {
        state.setSession(from, op.worker, undefined);
        return this.say(from, `fresh ${op.worker} session. same folder: ${short(op.cwd)}`);
      }
      case "claude":
      case "codex": {
        const worker = name as WorkerName;
        if (op.worker === worker) return this.say(from, `already on ${worker}.`);
        state.update(from, { worker });
        const resuming = op.sessions[worker] ? "resuming your last session" : "new session";
        return this.say(from, `switched to ${worker}, ${resuming}.`);
      }
      case "cd": {
        if (!rest) return this.say(from, `folder: ${op.cwd}`);
        const target = resolve(op.cwd, rest.replace(/^~(?=$|\/)/, homedir()));
        if (!existsSync(target) || !statSync(target).isDirectory()) return this.say(from, `no such folder: ${target}`);
        state.update(from, { cwd: target });
        return this.say(from, `folder: ${target}`);
      }
      case "status":
        return this.say(from, this.statusText(from, op));
      case "stop": {
        const job = this.jobs.get(from);
        const dropped = this.queued.get(from)?.length ?? 0;
        this.queued.delete(from);
        if (!job) return this.say(from, dropped ? `cleared ${dropped} queued.` : "nothing running.");
        job.ac.abort();
        return this.say(from, `stopping ${job.worker}${dropped ? `, cleared ${dropped} queued` : ""}.`);
      }
      case "verbose": {
        const verbose = !op.verbose;
        state.update(from, { verbose });
        return this.say(from, verbose ? "verbose on: I will narrate tool calls." : "verbose off: results only.");
      }
      case "auto":
      case "ask": {
        this.permissionOverride.set(from, name as PermissionPolicy);
        return this.say(
          from,
          name === "auto"
            ? "auto: the agent acts without asking."
            : "ask: every command and edit needs a yes from you (codex: writes confined to the folder).",
        );
      }
      case "yes":
      case "no":
        return this.answerApproval(from, name === "yes");
      default:
        return this.say(from, "unknown command. /help");
    }
  }

  private helpText(): string {
    const cmd = this.deps.config.fallthrough?.command;
    const fwd = cmd ? `\n/${cmd} <msg>: send to the old bot on this number` : "";
    return [
      "just text me what you want done. one task at a time; more texts queue up.",
      "",
      "/new: fresh session",
      "/claude or /codex: switch agent (each keeps its own session)",
      "/cd <folder>: set the working folder",
      "/status: what is running, where, on what",
      "/stop: cancel the current task",
      "/verbose: narrate tool calls on or off",
      "/auto or /ask: act freely, or ask me before every command",
      "/yes or /no: answer an approval" + fwd,
    ].join("\n");
  }

  private statusText(from: string, op: OperatorState): string {
    const job = this.jobs.get(from);
    const q = this.queued.get(from)?.length ?? 0;
    const load = loadavg()[0]!.toFixed(2);
    const freeGb = (freemem() / 1e9).toFixed(1);
    const totalGb = (totalmem() / 1e9).toFixed(1);
    const sess = (w: WorkerName) => (op.sessions[w] ? op.sessions[w]!.slice(0, 8) : "none");
    return [
      `agent: ${op.worker} (${this.permissions(from)}${op.verbose ? ", verbose" : ""})`,
      `folder: ${short(op.cwd)}`,
      `sessions: claude ${sess("claude")}, codex ${sess("codex")}`,
      job ? `running: ${job.worker}, ${fmtDuration(this.now() - job.startedAt)} in${q ? `, ${q} queued` : ""}` : "idle",
      this.sessionsLine(),
      `box: ${this.deps.config.machineName}, load ${load}, ${freeGb}/${totalGb} GB free, up ${fmtDuration(this.now() - this.startedAt)}`,
    ].join("\n");
  }

  private sessionsLine(): string {
    const live = this.listSessions();
    if (!live.length) return "terminal sessions: none";
    const parts = live.slice(0, 6).map((r) => `${basename(r.cwd)} (${r.state}${r.id ? ", " + r.id.slice(0, 8) : ""})`);
    const tells = this.tells.size ? `, ${this.tells.size} being steered` : "";
    return `terminal sessions: ${parts.join(", ")}${live.length > 6 ? `, +${live.length - 6}` : ""}${tells}`;
  }

  // ---- alerts (from scripts and other sessions) ---------------------------

  /**
   * A terminal session (or any script) wants the operator to know something.
   * Text it, tagged with where it came from, and remember it so the root
   * conversation knows what happened when the operator replies.
   */
  async alert(input: { text: string; cwd?: string; pid?: number; sessionId?: string; to?: string }): Promise<{
    sessionId?: string;
    cwd?: string;
    delivered: boolean;
  }> {
    const { state, sessions, config } = this.deps;
    const own = state.ownSessionIds();
    let rec: SessionRecord | undefined;
    if (input.sessionId) rec = sessions.get(input.sessionId);
    if (!rec && input.pid) rec = sessions.forPid(input.pid, own);
    if (!rec && input.cwd) rec = sessions.resolve(input.cwd, own)[0];
    const cwd = rec?.cwd ?? input.cwd;
    const fromOwn = rec ? own.includes(rec.id) : false;
    const tag = fromOwn ? undefined : cwd ? basename(cwd) : undefined;
    const text = tag ? `*${tag}*\n${input.text}` : input.text;

    const at = new Date(this.now()).toISOString();
    state.addAlert({ at, text: input.text, cwd, sessionId: rec?.id });
    const targets = input.to ? [input.to] : config.operators;
    let delivered = true;
    for (const op of targets) {
      this.operator(op);
      if (!fromOwn) {
        const where = rec ? `session ${rec.id.slice(0, 8)} in ${short(rec.cwd)}` : cwd ? `a script in ${short(cwd)}` : "a script";
        state.addNote(op, `${at.slice(11, 16)} alert from ${where}: ${input.text}`);
      }
      state.transcript(op, { dir: "alert", text: input.text, cwd, sessionId: rec?.id });
      try {
        await this.deps.send(op, text);
      } catch (e) {
        delivered = false;
        log.error("alert send failed", { to: op, err: e instanceof Error ? e.message : String(e) });
      }
    }
    return { sessionId: rec?.id, cwd, delivered };
  }

  // ---- tell: steer another session ------------------------------------------

  /**
   * Run an instruction inside a terminal session's conversation. If the session
   * is idle, its CLI process is stopped and the same session id is resumed
   * headlessly (one transcript, no branches). If it stays busy past the wait,
   * the transcript is forked instead so nothing in flight is lost.
   */
  tell(targetRef: string, instruction: string, opts: TellOptions = {}): TellJob {
    const { state, sessions } = this.deps;
    const own = state.ownSessionIds();
    const candidates = sessions.resolve(targetRef, own);
    if (!candidates.length) {
      const known = sessions.list({ exclude: own }).map((c) => `${basename(c.cwd)} ${c.id.slice(0, 8)}`).join(", ") || "none";
      const msg = `no session matches "${targetRef}" (known: ${known})`;
      void this.alert({ text: `dispatch tell failed: ${msg}\ninstruction: ${instruction.slice(0, 200)}` });
      throw new TellError(msg);
    }
    if (candidates.length > 1) {
      const names = candidates.map((c) => `${basename(c.cwd)} ${c.id.slice(0, 8)}`).join(", ");
      throw new TellError(`ambiguous: ${names}. use the session id.`, candidates);
    }
    const target = candidates[0]!;
    if (this.tells.has(target.id)) throw new TellError(`already running an instruction in ${basename(target.cwd)} (${target.id.slice(0, 8)})`);
    const ac = new AbortController();
    const id = `tell-${++this.tellSeq}`;
    const model = opts.model ?? this.deps.config.claudeModel;
    const job: TellJob = { id, target, instruction, startedAt: this.now(), ac, mode: opts.force ?? "resume", model, done: Promise.resolve() as unknown as Promise<TellResult> };
    job.done = this.runTell(job, opts).finally(() => this.tells.delete(target.id));
    this.tells.set(target.id, job);
    return job;
  }

  private async runTell(job: TellJob, opts: TellOptions): Promise<TellResult> {
    const { config, state, sessions, workers } = this.deps;
    const target = job.target;
    const label = basename(target.cwd);
    const t0 = this.now();

    let mode: "resume" | "fork" = opts.force ?? "resume";
    let note: string | undefined;
    let cur = sessions.get(target.id) ?? target;
    if (!opts.force) {
      // Wait for the session to finish its turn, then take it over.
      const deadline = this.now() + config.tellIdleWaitMs;
      while (cur.state === "busy" && this.now() < deadline && !job.ac.signal.aborted) {
        await sleep(1000);
        cur = sessions.list({ includeEnded: true }).find((r) => r.id === target.id) ?? cur;
      }
      if (cur.state === "busy") {
        mode = "fork";
        note = `${label} was still mid-turn after ${Math.round(config.tellIdleWaitMs / 1000)}s, so this ran as a fork; the original session was left alone.`;
        log.info("tell: session still busy, forking", { session: target.id });
      }
    }
    job.mode = mode;

    if (mode === "resume") {
      // Same session id, one transcript: whatever is running it must be stopped first.
      const stopped = await this.releaseSession(cur);
      if (stopped.ok) {
        if (stopped.how !== "nothing") {
          sessions.update(target.id, { state: "taken", takenAt: new Date(this.now()).toISOString(), takenFor: job.instruction.slice(0, 200), pid: 0 });
        }
        if (stopped.how === "background") {
          note = `${label} was a claude --bg session; dispatch stopped it and continued the same session id. Reopen it with: claude --resume ${target.id} (or claude attach ${cur.bgId ?? target.id.slice(0, 8)}).`;
        } else if (stopped.how === "nothing") {
          note = `${label} was not running; dispatch resumed its transcript headlessly. Reopen it with: claude --resume ${target.id}`;
        }
      } else {
        mode = "fork";
        job.mode = mode;
        note = `could not stop ${label} (${stopped.error}); ran as a fork instead, original session untouched.`;
        log.warn("tell: could not release session, forking", { session: target.id, err: stopped.error });
      }
    }

    // Which model this runs on is never left to chance: dispatch passes its
    // configured model (or the per-tell override) on resume and on fork. The
    // transcript still remembers what the session itself last ran on, so a
    // difference is reported instead of silently inherited.
    const model = job.model;
    const pinned = transcriptModel(cur.transcriptPath);
    const modelNote =
      pinned && model && !sameModel(pinned, model)
        ? `${label}'s own transcript last ran on ${pinned}; dispatch ran this on ${model}.`
        : undefined;

    const timeout = setTimeout(() => job.ac.abort(), config.tellTimeoutMs);
    let result: TellResult;
    try {
      const prompt =
        `[Instruction from the operator, sent from their phone via dispatch. ` +
        `This continues your session in ${target.cwd}. Do it, then reply with a short report; the reply is texted back verbatim.]\n\n` +
        job.instruction;
      const out = await workers.claude.run({
        prompt,
        images: [],
        cwd: target.cwd,
        resume: target.id,
        fork: mode === "fork",
        signal: job.ac.signal,
        permissions: "auto",
        systemPrompt: buildSystemPrompt({ machineName: config.machineName, cwd: target.cwd, stateDir: config.stateDir }),
        model,
        maxTurns: config.maxTurns,
        onEvent: () => undefined,
        approve: async () => true,
      });
      let text = out.text.trim();
      if (out.error === "aborted") text = job.ac.signal.aborted && this.now() - t0 >= config.tellTimeoutMs ? `stopped: hit the ${Math.round(config.tellTimeoutMs / 60000)} min tell timeout.` : "stopped before finishing.";
      else if (out.error && !text) text = `that did not go through: ${out.error}`;
      else if (out.error) text += `\n\n(ended with: ${out.error})`;
      if (out.sessionLost) text = `(could not resume session ${target.id.slice(0, 8)}, ran fresh in ${short(target.cwd)})\n\n${text}`;
      if (!text) text = "done. nothing to report.";
      if (out.sessionId && out.sessionId !== target.id) sessions.update(target.id, { continuedAs: out.sessionId });
      result = { ok: !out.error, text, sessionId: out.sessionId ?? target.id, mode, ms: this.now() - t0, model, note: joinNotes(note, modelNote) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("tell crashed", { session: target.id, err: msg });
      result = { ok: false, text: `crashed: ${msg}`, sessionId: target.id, mode, ms: this.now() - t0, model, note: joinNotes(note, modelNote) };
    } finally {
      clearTimeout(timeout);
    }

    // A failed tell is a bug to fix, never something to work around quietly:
    // the operator gets the exact error, and it lands in the root's context.
    if (!result.ok) {
      const ranOn = model ? model : "the CLI default (DISPATCH_CLAUDE_MODEL is not set)";
      const was = pinned && (!model || !sameModel(pinned, model)) ? `\nsession last ran on: ${pinned}` : "";
      const hint = isLimitError(result.text)
        ? `\nthat is a usage limit on ${ranOn}: pick another model with DISPATCH_CLAUDE_MODEL in ~/.dispatch/env (restart dispatch), or retry with dispatch tell --model <name>.`
        : "";
      await this.alert({
        text: `dispatch tell failed for ${label} (${target.id.slice(0, 8)}, ${mode})\nmodel: ${ranOn}${was}\ninstruction: ${job.instruction.slice(0, 200)}\nerror: ${result.text.slice(0, 1200)}${hint}`,
      });
    }

    const at = new Date(this.now()).toISOString().slice(11, 16);
    for (const op of config.operators) {
      this.operator(op);
      state.addNote(op, `${at} you told ${label} (${target.id.slice(0, 8)}, ${mode}${result.ok ? "" : ", FAILED"}): "${job.instruction.slice(0, 160)}" -> ${result.text.slice(0, 400)}${result.note ? ` [${result.note}]` : ""}`);
      state.transcript(op, { dir: "tell", session: target.id, cwd: target.cwd, mode, model, ok: result.ok, note: result.note, instruction: job.instruction, text: result.text, ms: result.ms });
      if ((opts.notify ?? true) && result.ok) await this.say(op, `*${label}*${mode === "fork" ? " (fork)" : ""}\n${result.text}${result.note ? `\n\n_${result.note}_` : ""}`);
    }
    log.info("tell done", { session: target.id, mode, model: model ?? "cli-default", ms: result.ms, ok: result.ok });
    return result;
  }

  /**
   * Make a session's transcript free to resume under the same id: stop the
   * terminal process, or ask the daemon to stop a `claude --bg` session. A
   * session with no process (taken or ended) needs nothing.
   */
  private async releaseSession(rec: SessionRecord): Promise<{ ok: true; how: "terminal" | "background" | "nothing" } | { ok: false; error: string }> {
    const { sessions } = this.deps;
    const agent = sessions.agents().find((a) => a.sessionId === rec.id);
    const isBackground = rec.kind === "background" || agent?.kind === "background";
    if (isBackground) {
      try {
        await (this.deps.stopBackground ?? ((r) => sessions.stopBackground(r)))({ ...rec, bgId: rec.bgId ?? agent?.id });
        return { ok: true, how: "background" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const pid = rec.pid || agent?.pid || 0;
    if (!pid) return { ok: true, how: "nothing" };
    if (await stopProcess(pid)) return { ok: true, how: "terminal" };
    return { ok: false, error: `process ${pid} did not exit on SIGTERM/SIGKILL` };
  }

  // ---- spawn: a fresh session for a subtask ---------------------------------

  /**
   * Start a brand new Claude Code session in a folder and hand it one task.
   * Runs headless and in parallel with everything else; the result is texted
   * to the operator. Afterwards the session is registered like any terminal
   * session, so `dispatch tell <folder>` continues it with its full history.
   */
  spawn(folder: string, instruction: string, opts: SpawnOptions = {}): SpawnJob {
    const { config } = this.deps;
    const cwd = resolve(config.workspace, folder.trim().replace(/^~(?=$|\/)/, homedir()) || ".");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new TellError(`no such folder: ${cwd}`);
    if (this.spawns.size >= config.maxSpawns) {
      throw new TellError(`already running ${this.spawns.size} spawned sessions (DISPATCH_MAX_SPAWNS=${config.maxSpawns}); wait for one to finish`);
    }
    const job: SpawnJob = {
      id: `spawn-${++this.spawnSeq}`,
      cwd,
      instruction,
      startedAt: this.now(),
      ac: new AbortController(),
      model: opts.model ?? config.claudeModel,
      notify: opts.notify ?? true,
      done: Promise.resolve() as unknown as Promise<SpawnResult>,
    };
    job.done = this.runSpawn(job).finally(() => this.spawns.delete(job.id));
    this.spawns.set(job.id, job);
    return job;
  }

  private async runSpawn(job: SpawnJob): Promise<SpawnResult> {
    const { config, state, sessions, workers } = this.deps;
    const label = basename(job.cwd);
    const t0 = this.now();
    const timeout = setTimeout(() => job.ac.abort(), config.tellTimeoutMs);
    let result: SpawnResult;
    try {
      const prompt =
        `[Task from the operator, sent from their phone via dispatch. You are a fresh session in ${job.cwd}. ` +
        `Do it end to end, then reply with a short report; the reply is texted back verbatim.]\n\n` +
        job.instruction;
      const out = await workers.claude.run({
        prompt,
        images: [],
        cwd: job.cwd,
        signal: job.ac.signal,
        permissions: "auto",
        systemPrompt: buildSystemPrompt({ machineName: config.machineName, cwd: job.cwd, stateDir: config.stateDir }),
        model: job.model,
        maxTurns: config.maxTurns,
        onEvent: () => undefined,
        onSession: (id) => {
          job.sessionId = id;
        },
        approve: async () => true,
      });
      let text = out.text.trim();
      if (out.error === "aborted") text = this.now() - t0 >= config.tellTimeoutMs ? `stopped: hit the ${Math.round(config.tellTimeoutMs / 60000)} min timeout.` : "stopped before finishing.";
      else if (out.error && !text) text = `that did not go through: ${out.error}`;
      else if (out.error) text += `\n\n(ended with: ${out.error})`;
      if (!text) text = "done. nothing to report.";
      result = { ok: !out.error, text, sessionId: out.sessionId ?? job.sessionId, ms: this.now() - t0, model: job.model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("spawn crashed", { cwd: job.cwd, err: msg });
      result = { ok: false, text: `crashed: ${msg}`, sessionId: job.sessionId, ms: this.now() - t0, model: job.model };
    } finally {
      clearTimeout(timeout);
    }

    // Register the new session so `dispatch tell` can continue it later. With
    // the hooks installed it is already there; this covers boxes without them.
    if (result.sessionId) {
      const ts = new Date(this.now()).toISOString();
      const existing = sessions.get(result.sessionId);
      sessions.put({
        ...existing,
        id: result.sessionId,
        cwd: job.cwd,
        pid: 0,
        state: "taken",
        startedAt: existing?.startedAt ?? new Date(t0).toISOString(),
        updatedAt: ts,
        takenAt: ts,
        takenFor: job.instruction.slice(0, 200),
        lastPrompt: job.instruction.split("\n")[0]!.slice(0, 120),
      });
    }

    const sid = result.sessionId ? result.sessionId.slice(0, 8) : "no session";
    const at = new Date(this.now()).toISOString().slice(11, 16);
    for (const op of config.operators) {
      this.operator(op);
      state.addNote(op, `${at} spawned a session in ${label} (${sid}${result.ok ? "" : ", FAILED"}): "${job.instruction.slice(0, 160)}" -> ${result.text.slice(0, 400)}`);
      state.transcript(op, { dir: "spawn", session: result.sessionId, cwd: job.cwd, model: job.model, ok: result.ok, instruction: job.instruction, text: result.text, ms: result.ms });
      if (job.notify) await this.say(op, `*${label}* (new session ${sid}${result.ok ? "" : ", failed"})\n${result.text}`);
    }
    log.info("spawn done", { cwd: job.cwd, session: result.sessionId, ms: result.ms, ok: result.ok });
    return result;
  }

  stopTell(sessionId: string): boolean {
    const job = this.tells.get(sessionId);
    if (!job) return false;
    job.ac.abort();
    return true;
  }

  // ---- jobs -------------------------------------------------------------

  private async run(from: string, msgs: InboundMessage[]): Promise<void> {
    const { config, state, workers } = this.deps;
    const op = this.operator(from);
    const worker = workers[op.worker];
    const ac = new AbortController();
    const job: Job = { worker: op.worker, startedAt: this.now(), ac, prompt: "", sentSomething: false };
    this.jobs.set(from, job);

    const timeout = setTimeout(() => ac.abort(), config.jobTimeoutMs);
    const slowNotice = setTimeout(() => {
      if (!job.sentSomething) void this.say(from, "on it. this one is taking a bit.");
    }, SLOW_NOTICE_MS);

    try {
      const { prompt, images } = await this.buildPrompt(from, msgs);
      job.prompt = prompt;
      const result = await worker.run({
        prompt,
        images,
        cwd: op.cwd,
        resume: op.sessions[op.worker],
        signal: ac.signal,
        permissions: this.permissions(from),
        systemPrompt: buildSystemPrompt({ machineName: config.machineName, cwd: op.cwd, stateDir: config.stateDir }),
        model: op.worker === "claude" ? config.claudeModel : config.codexModel,
        maxTurns: config.maxTurns,
        onEvent: (e) => this.onEvent(from, job, e),
        approve: (req) => this.askApproval(from, job, req),
      });

      if (result.sessionLost) state.setSession(from, op.worker, undefined);
      if (result.sessionId) state.setSession(from, op.worker, result.sessionId);

      let out = result.text.trim();
      if (result.error === "aborted") out = "stopped.";
      else if (result.error && !out) out = `that did not go through: ${result.error}`;
      else if (result.error) out += `\n\n(ended with: ${result.error})`;
      if (!out) out = "done. nothing to report back.";
      if (result.sessionLost) out = `(previous session was gone, started a new one)\n\n${out}`;

      state.transcript(from, { dir: "out", worker: op.worker, text: out, costUsd: result.costUsd, turns: result.turns });
      await this.say(from, out);
      log.info("job done", { operator: from, worker: op.worker, ms: this.now() - job.startedAt, costUsd: result.costUsd });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("job crashed", { operator: from, err: msg });
      await this.say(from, ac.signal.aborted ? "stopped." : `crashed: ${msg}`);
    } finally {
      clearTimeout(timeout);
      clearTimeout(slowNotice);
      this.jobs.delete(from);
      this.approvals.delete(from);
      const next = this.queued.get(from);
      this.queued.delete(from);
      if (next?.length) void this.run(from, next);
    }
  }

  private async buildPrompt(from: string, msgs: InboundMessage[]): Promise<{ prompt: string; images: string[] }> {
    const images: string[] = [];
    const notes: string[] = [];
    for (const m of msgs) {
      for (const [i, media] of m.media.entries()) {
        try {
          const bytes = await this.deps.download(media.url);
          const ext = extensionFor(media.contentType);
          const file = join(this.deps.state.mediaDir, `${m.sid}-${i}${ext}`);
          writeFileSync(file, bytes);
          if (media.contentType.startsWith("image/")) images.push(file);
          else notes.push(`[Attached file: ${file} (${media.contentType})]`);
        } catch (e) {
          log.warn("media download failed", { err: e instanceof Error ? e.message : String(e) });
          notes.push(`[An attachment of type ${media.contentType} failed to download]`);
        }
      }
    }
    const body = msgs.map((m) => m.body.trim()).filter(Boolean).join("\n\n");
    let prompt = [body, ...notes].filter(Boolean).join("\n\n") || "(the operator sent only attachments)";
    const since = this.deps.state.takeNotes(from);
    if (since.length) {
      prompt =
        "[Since your last turn, these were already texted to the operator by dispatch; they are context, not new requests:]\n" +
        since.map((n) => `- ${n}`).join("\n") +
        "\n\n" +
        prompt;
    }
    return { prompt, images };
  }

  private onEvent(from: string, job: Job, e: WorkerEvent): void {
    const op = this.operator(from);
    if (!op.verbose) return;
    if (e.kind === "tool") void this.say(from, `> ${e.text}`);
    else if (e.kind === "text") void this.say(from, e.text);
    job.sentSomething = true;
  }

  // ---- approvals ----------------------------------------------------------

  private askApproval(from: string, job: Job, req: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(from);
        resolve(false);
      }, this.deps.config.approvalTimeoutMs);
      this.approvals.set(from, {
        req,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      });
      job.sentSomething = true;
      void this.say(from, `approve?\n${req.summary}\n\nyes / no`);
    });
  }

  private async answerApproval(from: string, ok: boolean): Promise<void> {
    const pending = this.approvals.get(from);
    if (!pending) return this.say(from, "nothing waiting for approval.");
    this.approvals.delete(from);
    pending.resolve(ok);
  }

  // ---- strangers ------------------------------------------------------------

  private async stranger(params: Record<string, string>, msg: InboundMessage): Promise<void> {
    const { config } = this.deps;
    if (config.fallthrough) {
      log.info("forwarding stranger", { from: msg.from });
      await this.deps.forward(params);
      return;
    }
    log.info("ignoring stranger", { from: msg.from });
    if (!config.fallthroughReply) return;
    const last = this.strangerRepliedAt.get(msg.from) ?? 0;
    if (this.now() - last < STRANGER_COOLDOWN_MS) return;
    this.strangerRepliedAt.set(msg.from, this.now());
    await this.deps.send(msg.from, config.fallthroughReply);
  }

  private async say(to: string, text: string): Promise<void> {
    try {
      await this.deps.send(to, text);
    } catch (e) {
      log.error("send failed", { to, err: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Everything the operator should know about how the tell ran, in one line. */
function joinNotes(...parts: Array<string | undefined>): string | undefined {
  const out = parts.filter((p): p is string => Boolean(p && p.trim())).join(" ");
  return out || undefined;
}

/** A model/usage limit rather than a bug in the instruction: the fix is a different model. */
function isLimitError(text: string): boolean {
  return /\b(limit|quota|usage credits?|out of credits?)\b/i.test(text);
}

function short(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[contentType.split(";")[0]!.trim()] ?? "";
}
