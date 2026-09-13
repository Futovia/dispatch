import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WorkerName } from "./config.js";

/**
 * All durable state is one JSON file plus grep-able JSONL transcripts in the
 * state dir. No database. The interesting memory lives in the agents' own
 * session stores (~/.claude, ~/.codex); we only keep the ids to resume them.
 */
export interface OperatorState {
  worker: WorkerName;
  cwd: string;
  verbose: boolean;
  sessions: Partial<Record<WorkerName, string>>;
  lastInboundAt?: string;
  /** Things that happened since the operator's last message (alerts, tell outcomes). Fed into the next prompt. */
  notes?: string[];
}

export interface AlertRecord {
  at: string;
  text: string;
  cwd?: string;
  sessionId?: string;
  /** Outbound WhatsApp MessageSid, when the send went through. */
  sid?: string;
}

export interface StateFile {
  version: 1;
  localToken: string;
  operators: Record<string, OperatorState>;
  /** Recent inbound MessageSids; Twilio retries a webhook it did not get a 200 for. */
  seen: string[];
  /** Recent alerts sent to the phone, newest last. */
  alerts?: AlertRecord[];
}

const SEEN_CAP = 500;
const ALERT_CAP = 50;
const NOTE_CAP = 40;

export class State {
  private data: StateFile;
  readonly file: string;
  readonly mediaDir: string;
  readonly transcriptsDir: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "state.json");
    this.mediaDir = join(dir, "media");
    this.transcriptsDir = join(dir, "transcripts");
    mkdirSync(this.mediaDir, { recursive: true });
    mkdirSync(this.transcriptsDir, { recursive: true });
    this.data = this.read();
  }

  private read(): StateFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
        if (parsed.version === 1) return { ...parsed, operators: parsed.operators ?? {}, seen: parsed.seen ?? [] };
      } catch {
        // fall through to a fresh file; a corrupt state file must not brick the daemon
      }
    }
    const fresh: StateFile = { version: 1, localToken: randomBytes(24).toString("hex"), operators: {}, seen: [] };
    this.write(fresh);
    return fresh;
  }

  private write(data: StateFile): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get localToken(): string {
    return this.data.localToken;
  }

  operator(address: string, defaults: { worker: WorkerName; cwd: string }): OperatorState {
    let op = this.data.operators[address];
    if (!op) {
      op = { worker: defaults.worker, cwd: defaults.cwd, verbose: false, sessions: {} };
      this.data.operators[address] = op;
      this.write(this.data);
    }
    return op;
  }

  update(address: string, patch: Partial<OperatorState>): OperatorState {
    const op = this.data.operators[address];
    if (!op) throw new Error(`unknown operator ${address}`);
    Object.assign(op, patch);
    this.write(this.data);
    return op;
  }

  setSession(address: string, worker: WorkerName, sessionId: string | undefined): void {
    const op = this.data.operators[address];
    if (!op) return;
    if (sessionId) op.sessions[worker] = sessionId;
    else delete op.sessions[worker];
    this.write(this.data);
  }

  /** True the first time a MessageSid is seen; false on a Twilio retry. */
  markSeen(sid: string): boolean {
    if (this.data.seen.includes(sid)) return false;
    this.data.seen.push(sid);
    if (this.data.seen.length > SEEN_CAP) this.data.seen.splice(0, this.data.seen.length - SEEN_CAP);
    this.write(this.data);
    return true;
  }

  /** Queue a line of context for the operator's next prompt. */
  addNote(address: string, text: string): void {
    const op = this.data.operators[address];
    if (!op) return;
    op.notes = [...(op.notes ?? []), text].slice(-NOTE_CAP);
    this.write(this.data);
  }

  /** Drain queued context. */
  takeNotes(address: string): string[] {
    const op = this.data.operators[address];
    if (!op?.notes?.length) return [];
    const notes = op.notes;
    op.notes = [];
    this.write(this.data);
    return notes;
  }

  addAlert(rec: AlertRecord): void {
    this.data.alerts = [...(this.data.alerts ?? []), rec].slice(-ALERT_CAP);
    this.write(this.data);
  }

  alerts(): AlertRecord[] {
    return this.data.alerts ?? [];
  }

  /** Every session id dispatch itself drives (so they are never targets of `tell`). */
  ownSessionIds(): string[] {
    const ids: string[] = [];
    for (const op of Object.values(this.data.operators)) for (const id of Object.values(op.sessions)) if (id) ids.push(id);
    return ids;
  }

  /** One JSONL line per inbound/outbound message, per operator. `grep` is the UI. */
  transcript(address: string, entry: Record<string, unknown>): void {
    const file = join(this.transcriptsDir, address.replace(/[^0-9]/g, "") + ".jsonl");
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  }
}
