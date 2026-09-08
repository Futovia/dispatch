import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, loadavg, freemem, totalmem } from "node:os";
import type { Config, WorkerName, PermissionPolicy } from "./config.js";
import type { State, OperatorState } from "./state.js";
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
  workers: Record<WorkerName, Worker>;
  /** Deliver text to a WhatsApp address (already formatted + chunked by the caller). */
  send: (to: string, text: string) => Promise<void>;
  /** Forward a raw webhook to the fallthrough service. */
  forward: (params: Record<string, string>) => Promise<void>;
  /** Download inbound media; returns the bytes. */
  download: (url: string) => Promise<Buffer>;
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

const COMMANDS = ["help", "new", "claude", "codex", "cd", "status", "stop", "verbose", "yes", "no", "auto", "ask"];
const STRANGER_COOLDOWN_MS = 60 * 60 * 1000;
const SLOW_NOTICE_MS = 45_000;

export class Router {
  private jobs = new Map<string, Job>();
  private queued = new Map<string, InboundMessage[]>();
  private approvals = new Map<string, PendingApproval>();
  private strangerRepliedAt = new Map<string, number>();
  private permissionOverride = new Map<string, PermissionPolicy>();
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
    };
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
    const fwd = this.deps.config.fallthrough ? `\n/${this.deps.config.fallthrough.command} <msg>: send to the old bot on this number` : "";
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
      `box: ${this.deps.config.machineName}, load ${load}, ${freeGb}/${totalGb} GB free, up ${fmtDuration(this.now() - this.startedAt)}`,
    ].join("\n");
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
    const prompt = [body, ...notes].filter(Boolean).join("\n\n") || "(the operator sent only attachments)";
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
