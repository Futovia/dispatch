import { execFile } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "../history.js";
import type { InboundMessage, InboundMedia } from "../twilio.js";
import { chunk, toWhatsApp } from "../wa-format.js";
import { log } from "../log.js";
import type { Channel, ChannelStatus } from "./types.js";

/**
 * iMessage on a Mac signed in to Messages, with no server and no API:
 * - in: Messages keeps every message in ~/Library/Messages/chat.db (SQLite).
 *   We read it (read-only) every pollMs for rows past the last one seen. That
 *   needs Full Disk Access for the node binary running dispatch.
 * - out: Messages' AppleScript `send`, through osascript. That needs the
 *   Automation permission for node to control Messages (macOS asks once).
 *
 * The Mac should have its own Apple ID. If it shares the operator's, their
 * texts arrive as the account's own (is_from_me) and are never acted on.
 */
const run = promisify(execFile);

/** Seconds to wait for an attachment to finish downloading before delivering without it. */
const ATTACHMENT_WAIT_MS = 60_000;
const REOPEN_MS = 30_000;
const IM_MAX_CHARS = 6000;

export interface IMessageOptions {
  dbPath: string;
  pollMs: number;
  mediaDir: string;
  /** Send `text` to `handle` through Messages. Tests replace it; the default runs osascript. */
  sendRaw?: (handle: string, text: string) => Promise<void>;
  /** HEIC -> JPEG (the agent cannot read HEIC). Default: macOS sips. */
  toJpeg?: (src: string, dest: string) => Promise<void>;
  now?: () => number;
}

export interface IMessageDeps {
  /** Only these senders get through; everyone else is skipped before anything is copied. */
  accept: (address: string) => boolean;
  onMessage: (msg: InboundMessage) => void | Promise<void>;
  cursor: () => number | undefined;
  setCursor: (rowid: number) => void;
}

interface Row {
  id: number;
  guid: string;
  text: string | null;
  body: Uint8Array | null;
  fromMe: number;
  service: string | null;
  room: string | null;
  assoc: number | null;
  itemType: number | null;
  hasAtt: number | null;
  handle: string | null;
}

export class IMessageChannel implements Channel {
  readonly name = "imessage" as const;
  private db?: DatabaseSync;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private openError?: string;
  private sendError?: string;
  private nextOpenAt = 0;
  /** When we first saw a message whose attachment was still downloading. */
  private waitingSince = new Map<number, number>();

  constructor(
    private opts: IMessageOptions,
    private deps: IMessageDeps,
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  start(): void {
    this.open();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
    this.db = undefined;
  }

  status(): ChannelStatus {
    if (this.openError) return { ok: false, detail: this.openError };
    if (this.sendError) return { ok: false, detail: this.sendError };
    return { ok: true };
  }

  private open(): boolean {
    if (this.db) return true;
    if (this.now() < this.nextOpenAt) return false;
    try {
      this.db = new (loadSqlite().DatabaseSync)(this.opts.dbPath, { readOnly: true });
      this.db.prepare("SELECT 1 FROM message LIMIT 1").get();
      if (this.deps.cursor() === undefined) {
        // First start: begin at the newest message, never replay the inbox.
        const row = this.db.prepare("SELECT MAX(ROWID) AS id FROM message").get() as { id: number | null };
        this.deps.setCursor(Number(row.id ?? 0));
      }
      if (this.openError) log.info("imessage: reading Messages again");
      this.openError = undefined;
      return true;
    } catch (e) {
      this.db?.close();
      this.db = undefined;
      const why = explainOpenError(this.opts.dbPath, e);
      if (why !== this.openError) log.error("imessage: cannot read Messages", { detail: why });
      this.openError = why;
      this.nextOpenAt = this.now() + REOPEN_MS;
      return false;
    }
  }

  /** One pass over messages newer than the cursor. Public for tests. */
  async poll(): Promise<void> {
    if (this.polling || !this.open()) return;
    this.polling = true;
    try {
      const rows = this.db!.prepare(
        `SELECT m.ROWID AS id, m.guid, m.text, m.attributedBody AS body, m.is_from_me AS fromMe, m.service,
                m.cache_roomnames AS room, m.associated_message_type AS assoc, m.item_type AS itemType,
                m.cache_has_attachments AS hasAtt, h.id AS handle
           FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT 100`,
      ).all(this.deps.cursor() ?? 0) as unknown as Row[];
      for (const row of rows) {
        const msg = this.toMessage(row);
        if (msg === "wait") break; // an attachment is still downloading; come back to this row
        this.deps.setCursor(row.id);
        if (msg) await this.deps.onMessage({ ...msg, media: await this.prepareMedia(msg.media) });
      }
    } catch (e) {
      log.warn("imessage: poll failed", { err: e instanceof Error ? e.message : String(e) });
      // A database that went away (Messages reset, permission revoked) is reopened.
      this.db?.close();
      this.db = undefined;
    } finally {
      this.polling = false;
    }
  }

  private toMessage(row: Row): InboundMessage | null | "wait" {
    // Only plain 1:1 iMessages from someone else. SMS is skipped: its sender can be spoofed.
    if (row.fromMe || row.service !== "iMessage" || row.room || row.assoc || row.itemType || !row.handle) return null;
    let handle: string;
    try {
      handle = row.handle.includes("@") ? row.handle.trim().toLowerCase() : `+${row.handle.replace(/[^0-9]/g, "")}`;
    } catch {
      return null;
    }
    const from = `imessage:${handle}`;
    if (!this.deps.accept(from)) {
      log.debug("imessage: ignoring a sender who is not an operator", { from });
      return null;
    }
    const text = (row.text ?? (row.body ? decodeAttributedBody(row.body) : undefined) ?? "").replace(/￼/g, "").trim();
    let media: InboundMedia[] = [];
    if (row.hasAtt) {
      const got = this.attachments(row.id);
      if (got === "wait") return "wait";
      media = got;
    }
    this.waitingSince.delete(row.id);
    if (!text && !media.length) return null;
    return { sid: `imessage:${row.guid}`, channel: "imessage", from, to: "", body: text, media };
  }

  private attachments(messageId: number): InboundMedia[] | "wait" {
    const rows = this.db!.prepare(
      `SELECT a.filename, a.mime_type AS mime, a.transfer_name AS name
         FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
        WHERE j.message_id = ?`,
    ).all(messageId) as Array<{ filename: string | null; mime: string | null; name: string | null }>;
    const files = rows.map((r) => ({ ...r, path: r.filename ? r.filename.replace(/^~(?=\/)/, homedir()) : "" }));
    const missing = files.some((f) => !f.path || !existsSync(f.path));
    if (missing) {
      const since = this.waitingSince.get(messageId) ?? this.now();
      this.waitingSince.set(messageId, since);
      if (this.now() - since < ATTACHMENT_WAIT_MS) return "wait";
      log.warn("imessage: attachment never finished downloading; delivering without it", { messageId });
    }
    const out: InboundMedia[] = [];
    for (const [i, f] of files.entries()) {
      if (!f.path || !existsSync(f.path)) continue;
      const contentType = f.mime || "application/octet-stream";
      const dest = join(this.opts.mediaDir, `imessage-${messageId}-${i}${extname(f.path).toLowerCase()}`);
      copyFileSync(f.path, dest);
      out.push({ path: dest, contentType });
    }
    return out;
  }

  async send(address: string, text: string): Promise<void> {
    const handle = address.replace(/^imessage:/, "");
    const sendRaw = this.opts.sendRaw ?? osascriptSend;
    try {
      for (const part of renderForIMessage(text)) await sendRaw(handle, part);
      this.sendError = undefined;
    } catch (e) {
      this.sendError = explainSendError(e);
      throw new Error(this.sendError);
    }
  }

  /** HEIC photos from an iPhone become JPEG; the agent reads JPEG, not HEIC. */
  async prepareMedia(media: InboundMedia[]): Promise<InboundMedia[]> {
    const toJpeg = this.opts.toJpeg ?? sipsToJpeg;
    const out: InboundMedia[] = [];
    for (const m of media) {
      if (m.path && /heic|heif/i.test(m.contentType + extname(m.path))) {
        const dest = m.path.replace(/\.[^.]+$/, "") + ".jpg";
        try {
          await toJpeg(m.path, dest);
          out.push({ path: dest, contentType: "image/jpeg" });
          continue;
        } catch (e) {
          log.warn("imessage: could not convert HEIC", { err: e instanceof Error ? e.message : String(e) });
        }
      }
      out.push(m);
    }
    return out;
  }
}

const SEND_SCRIPT = [
  "on run argv",
  "set theHandle to item 1 of argv",
  "set theText to item 2 of argv",
  'tell application "Messages"',
  "set theService to 1st account whose service type = iMessage",
  "try",
  "send theText to participant theHandle of theService",
  "on error",
  "send theText to buddy theHandle of theService",
  "end try",
  "end tell",
  "end run",
];

/** The text and handle travel as arguments, never inside the script, so nothing in them can run. */
async function osascriptSend(handle: string, text: string): Promise<void> {
  const args = SEND_SCRIPT.flatMap((l) => ["-e", l]);
  await run("osascript", [...args, handle, text], { timeout: 30_000 });
}

async function sipsToJpeg(src: string, dest: string): Promise<void> {
  await run("sips", ["-s", "format", "jpeg", src, "--out", dest], { timeout: 30_000 });
}

function explainOpenError(dbPath: string, e: unknown): string {
  try {
    statSync(dbPath);
  } catch (s) {
    const code = (s as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `no Messages database at ${dbPath}: open Messages on this Mac and sign in with its Apple ID`;
    if (code === "EPERM" || code === "EACCES") return fullDiskAccessHint();
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /authoriz|permission|not permitted|unable to open/i.test(msg) ? fullDiskAccessHint() : `cannot read ${dbPath}: ${msg}`;
}

export function fullDiskAccessHint(bin = process.execPath): string {
  return `no Full Disk Access: System Settings > Privacy & Security > Full Disk Access, add ${bin}, then restart dispatch`;
}

function explainSendError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const msg = `${err.stderr ?? ""} ${err.message ?? String(e)}`;
  if (/-1743|not authori[sz]ed to send apple events/i.test(msg)) {
    return `not allowed to control Messages: System Settings > Privacy & Security > Automation, allow ${process.execPath} to control Messages`;
  }
  if (/-1728|can.t get account|can.t get participant|can.t get buddy/i.test(msg)) {
    return "Messages has no iMessage account signed in (or the recipient is not on iMessage)";
  }
  return `iMessage send failed: ${msg.trim().slice(0, 300)}`;
}

/**
 * Messages stores newer texts only in attributedBody, an NSAttributedString in
 * Apple's old typedstream format. The plain string sits after the "NSString"
 * class name and a "+" marker, prefixed with its length (one byte, or 0x81 +
 * uint16 LE, or 0x82 + uint32 LE).
 */
export function decodeAttributedBody(blob: Uint8Array): string | undefined {
  const buf = Buffer.from(blob);
  const at = buf.indexOf("NSString");
  if (at < 0) return undefined;
  const plus = buf.indexOf(0x2b, at + 8);
  if (plus < 0 || plus > at + 16) return undefined;
  let p = plus + 1;
  let len = buf[p];
  if (len === undefined) return undefined;
  p += 1;
  if (len === 0x81) {
    len = buf.readUInt16LE(p);
    p += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(p);
    p += 4;
  }
  if (p + len > buf.length) return undefined;
  return buf.subarray(p, p + len).toString("utf8");
}

/** Markdown in, iMessage text out: same cleanup as WhatsApp, minus the emphasis markers iMessage would show literally. */
export function renderForIMessage(md: string): string[] {
  const text = toWhatsApp(md)
    .replace(/(^|[\s(\[])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s).,:;!?\]])/gm, "$1$2")
    .replace(/(^|[\s(\[])_(\S(?:[^_\n]*?\S)?)_(?=$|[\s).,:;!?\]])/gm, "$1$2")
    .replace(/```\w*\n?/g, "");
  return text.trim() ? chunk(text, IM_MAX_CHARS) : [];
}

/** The Apple IDs this Mac's user is signed in to iCloud with (best effort; Messages can differ). */
export async function macAppleIds(): Promise<string[]> {
  try {
    const { stdout } = await run("defaults", ["read", "MobileMeAccounts", "Accounts"], { timeout: 5000 });
    return [...stdout.matchAll(/AccountID\s*=\s*"?([^";\n]+)"?;/g)].map((m) => m[1]!.trim().toLowerCase());
  } catch {
    return [];
  }
}

/** Whether this process can read Messages' database: "ok", "denied" (Full Disk Access), or "missing". */
export function chatDbAccess(dbPath = join(homedir(), "Library", "Messages", "chat.db")): "ok" | "denied" | "missing" {
  try {
    statSync(dbPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "denied";
  }
  try {
    const db = new (loadSqlite().DatabaseSync)(dbPath, { readOnly: true });
    db.prepare("SELECT 1 FROM message LIMIT 1").get();
    db.close();
    return "ok";
  } catch {
    return "denied";
  }
}
