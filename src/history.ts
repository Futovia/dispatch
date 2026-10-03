import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { InboundMessage } from "./twilio.js";

/**
 * The long-running memory of each operator's WhatsApp conversation, in one
 * SQLite file (<stateDir>/history.db) through Node's built-in node:sqlite: no
 * native module, nothing for the installer to compile.
 *
 * Two tables:
 * - messages: every line in and out, across worker sessions, /new and restarts.
 *   A fresh worker session is primed from it, and `dispatch history` reads it.
 * - pending: texts waiting out the debounce window, so a restart inside the
 *   window does not drop them.
 */
export interface HistoryEntry {
  id: number;
  operator: string;
  at: string;
  dir: string;
  text: string;
  worker?: string;
  session?: string;
  meta?: Record<string, unknown>;
}

export interface PendingMessage {
  msg: InboundMessage;
  /** Epoch ms the text arrived. */
  at: number;
  /** Its row in messages, when it was recorded there. */
  historyId?: number;
}

/** `dir` of the marker /new writes: priming a fresh session stops here. */
export const RESET = "reset";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  operator TEXT NOT NULL,
  at TEXT NOT NULL,
  dir TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  worker TEXT,
  session TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS messages_operator ON messages(operator, id);
CREATE TABLE IF NOT EXISTS pending (
  sid TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  at INTEGER NOT NULL,
  history_id INTEGER,
  msg TEXT NOT NULL
);
`;

export class History {
  private db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(readonly file: string, opts: { importDir?: string } = {}) {
    const isNew = file === ":memory:" || !existsSync(file);
    this.db = new (loadSqlite().DatabaseSync)(file);
    // The daemon writes while `dispatch history` reads from another process.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    if (isNew && opts.importDir) this.importTranscripts(opts.importDir);
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Append one line; returns its id. */
  record(operator: string, entry: Record<string, unknown>, at = new Date().toISOString()): number {
    const { dir, text, worker, session, t: _t, ...rest } = entry;
    const r = this.stmt("INSERT INTO messages (operator, at, dir, text, worker, session, meta) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      operator,
      at,
      String(dir ?? "note"),
      typeof text === "string" ? text : "",
      typeof worker === "string" ? worker : null,
      typeof session === "string" ? session : null,
      Object.keys(rest).length ? JSON.stringify(rest) : null,
    );
    return Number(r.lastInsertRowid);
  }

  /** The newest `limit` entries (oldest first), optionally for one operator and matching `search`. */
  recent(opts: { operator?: string; limit?: number; search?: string; afterId?: number; beforeId?: number } = {}): HistoryEntry[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.operator) {
      where.push("operator = ?");
      args.push(opts.operator);
    }
    if (opts.search) {
      where.push("text LIKE ? ESCAPE '\\'");
      args.push(`%${opts.search.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    }
    if (opts.afterId !== undefined) {
      where.push("id > ?");
      args.push(opts.afterId);
    }
    if (opts.beforeId !== undefined) {
      where.push("id < ?");
      args.push(opts.beforeId);
    }
    const sql = `SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    const rows = this.stmt(sql).all(...args, opts.limit ?? 50) as unknown as Array<Record<string, unknown>>;
    return rows.reverse().map(toEntry);
  }

  /**
   * The conversation since the operator's last /new (texts and replies only, no
   * slash commands, minus `exclude`: the batch about to run), to catch up a
   * session that starts without one.
   */
  sinceReset(operator: string, limit: number, exclude: number[] = []): HistoryEntry[] {
    const row = this.stmt("SELECT MAX(id) AS id FROM messages WHERE operator = ? AND dir = ?").get(operator, RESET) as { id: number | null };
    const skip = new Set(exclude);
    return this.recent({ operator, limit: limit * 2 + skip.size, afterId: row.id ?? 0 })
      .filter((e) => !skip.has(e.id) && ((e.dir === "in" && !e.text.trim().startsWith("/")) || e.dir === "out"))
      .slice(-limit);
  }

  addPending(operator: string, p: PendingMessage): void {
    this.stmt("INSERT OR REPLACE INTO pending (sid, operator, at, history_id, msg) VALUES (?, ?, ?, ?, ?)").run(
      p.msg.sid,
      operator,
      p.at,
      p.historyId ?? null,
      JSON.stringify(p.msg),
    );
  }

  pending(operator: string): PendingMessage[] {
    const rows = this.stmt("SELECT at, history_id, msg FROM pending WHERE operator = ? ORDER BY at, rowid").all(operator) as Array<{
      at: number;
      history_id: number | null;
      msg: string;
    }>;
    return rows.map((r) => ({ at: Number(r.at), historyId: r.history_id ?? undefined, msg: JSON.parse(r.msg) as InboundMessage }));
  }

  pendingOperators(): string[] {
    return (this.stmt("SELECT DISTINCT operator FROM pending").all() as Array<{ operator: string }>).map((r) => r.operator);
  }

  clearPending(operator: string): void {
    this.stmt("DELETE FROM pending WHERE operator = ?").run(operator);
  }

  close(): void {
    this.db.close();
  }

  /** First open on a box that ran an older dispatch: carry the JSONL transcripts over. */
  private importTranscripts(dir: string): void {
    if (!existsSync(dir)) return;
    this.db.exec("BEGIN");
    try {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const base = name.replace(/\.jsonl$/, "");
        const operator = /^\d+$/.test(base) ? `whatsapp:+${base}` : base.replace(/^imessage-/, "imessage:");
        for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as Record<string, unknown>;
            this.record(operator, e, typeof e.t === "string" ? e.t : new Date(0).toISOString());
          } catch {
            // a torn line is not worth failing the import over
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function toEntry(r: Record<string, unknown>): HistoryEntry {
  return {
    id: Number(r.id),
    operator: String(r.operator),
    at: String(r.at),
    dir: String(r.dir),
    text: String(r.text ?? ""),
    worker: (r.worker as string | null) ?? undefined,
    session: (r.session as string | null) ?? undefined,
    meta: r.meta ? (JSON.parse(String(r.meta)) as Record<string, unknown>) : undefined,
  };
}

/** node:sqlite prints an ExperimentalWarning on load on Node 22; it is stable enough for this and the noise lands in the log. */
export function loadSqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}
