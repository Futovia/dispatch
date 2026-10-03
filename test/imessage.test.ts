import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "../src/history.js";
import { IMessageChannel, decodeAttributedBody, renderForIMessage } from "../src/channels/imessage.js";
import { pickAddress } from "../src/channels/route.js";
import { loadConfig, resolveOperators } from "../src/config.js";
import type { InboundMessage } from "../src/twilio.js";

/** The slice of Messages' chat.db schema dispatch reads. */
const SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB,
  handle_id INTEGER DEFAULT 0, service TEXT, is_from_me INTEGER DEFAULT 0, cache_roomnames TEXT,
  associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, date INTEGER);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, mime_type TEXT, transfer_name TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
`;

/** An attributedBody as Messages writes it: typedstream, the text after NSString + "+" + length. */
function attributed(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const len = bytes.length < 0x80 ? Buffer.from([bytes.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from(Uint16Array.of(bytes.length).buffer)]);
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"),
    len,
    bytes,
    Buffer.from("\x86\x84\x02iI\x01", "latin1"),
  ]);
}

describe("iMessage channel", () => {
  let dir: string;
  let db: DatabaseSync;
  let dbPath: string;
  let got: InboundMessage[];
  let cursor: number | undefined;
  let sent: Array<[string, string]>;
  let now: number;
  let seq = 0;

  const OPS = new Set(["imessage:me@icloud.com", "imessage:+15550001111"]);

  function channel(extra: Partial<ConstructorParameters<typeof IMessageChannel>[0]> = {}) {
    return new IMessageChannel(
      {
        dbPath,
        pollMs: 1000,
        mediaDir: join(dir, "media"),
        sendRaw: async (h, t) => {
          sent.push([h, t]);
        },
        toJpeg: async (_src, dest) => writeFileSync(dest, "jpeg"),
        now: () => now,
        ...extra,
      },
      {
        accept: (a) => OPS.has(a),
        onMessage: (m) => {
          got.push(m);
        },
        cursor: () => cursor,
        setCursor: (n) => {
          cursor = n;
        },
      },
    );
  }

  function handle(id: string): number {
    const row = db.prepare("SELECT ROWID AS id FROM handle WHERE id = ?").get(id) as { id: number } | undefined;
    if (row) return row.id;
    return Number(db.prepare("INSERT INTO handle (id, service) VALUES (?, 'iMessage')").run(id).lastInsertRowid);
  }

  function message(from: string, fields: Record<string, unknown> = {}): number {
    const row = { guid: `G-${++seq}`, text: null, attributedBody: null, handle_id: handle(from), service: "iMessage", is_from_me: 0, cache_roomnames: null, associated_message_type: 0, item_type: 0, cache_has_attachments: 0, ...fields };
    const cols = Object.keys(row);
    return Number(
      db.prepare(`INSERT INTO message (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(row) as Array<string | number | null | Buffer>)).lastInsertRowid,
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-im-"));
    mkdirSync(join(dir, "media"));
    dbPath = join(dir, "chat.db");
    db = new (loadSqlite().DatabaseSync)(dbPath);
    db.exec(SCHEMA);
    got = [];
    sent = [];
    cursor = undefined;
    now = 1_000_000;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts at the newest message, then delivers only new 1:1 iMessages from operators", async () => {
    message("me@icloud.com", { text: "old, before dispatch started" });
    const ch = channel();
    await ch.poll();
    expect(got).toEqual([]);
    expect(cursor).toBe(1);

    message("Me@iCloud.com", { text: "hello from my Apple ID" });
    message("+1 (555) 000-1111", { text: "and from my phone" });
    message("stranger@x.com", { text: "spam" });
    message("me@icloud.com", { text: "sent by the Mac itself", is_from_me: 1 });
    message("me@icloud.com", { text: "green bubble", service: "SMS" });
    message("me@icloud.com", { text: "group", cache_roomnames: "chat123" });
    message("me@icloud.com", { text: "Loved “hello”", associated_message_type: 2000 });
    message("me@icloud.com", { attributedBody: attributed("only in attributedBody \u{1F680}") });
    await ch.poll();

    expect(got.map((m) => [m.from, m.body])).toEqual([
      ["imessage:me@icloud.com", "hello from my Apple ID"],
      ["imessage:+15550001111", "and from my phone"],
      ["imessage:me@icloud.com", "only in attributedBody \u{1F680}"],
    ]);
    expect(got[0]!.sid).toMatch(/^imessage:G-/);
    expect(got[0]!.channel).toBe("imessage");
    expect(cursor).toBe(9); // skipped rows are passed over too
    await ch.poll();
    expect(got).toHaveLength(3);
    ch.stop();
  });

  it("waits for an attachment to download, copies it, and turns HEIC into JPEG", async () => {
    const ch = channel();
    await ch.poll();
    const file = join(dir, "IMG_0001.HEIC");
    const id = message("me@icloud.com", { text: "￼what is this?", cache_has_attachments: 1 });
    const att = Number(db.prepare("INSERT INTO attachment (filename, mime_type, transfer_name) VALUES (?, 'image/heic', 'IMG_0001.HEIC')").run(file).lastInsertRowid);
    db.prepare("INSERT INTO message_attachment_join VALUES (?, ?)").run(id, att);

    await ch.poll(); // file not there yet
    expect(got).toEqual([]);
    expect(cursor).toBe(id - 1);

    writeFileSync(file, "heic bytes");
    now += 5_000;
    await ch.poll();
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toBe("what is this?");
    expect(got[0]!.media).toEqual([{ path: join(dir, "media", `imessage-${id}-0.jpg`), contentType: "image/jpeg" }]);
    expect(existsSync(got[0]!.media[0]!.path!)).toBe(true);
    ch.stop();
  });

  it("delivers the text without an attachment that never arrives", async () => {
    const ch = channel();
    await ch.poll();
    const id = message("me@icloud.com", { text: "see attached", cache_has_attachments: 1 });
    const att = Number(db.prepare("INSERT INTO attachment (filename, mime_type) VALUES ('~/nope/never.png', 'image/png')").run().lastInsertRowid);
    db.prepare("INSERT INTO message_attachment_join VALUES (?, ?)").run(id, att);
    await ch.poll();
    expect(got).toEqual([]);
    now += 61_000;
    await ch.poll();
    expect(got.map((m) => [m.body, m.media])).toEqual([["see attached", []]]);
    ch.stop();
  });

  it("explains a missing Messages database, and reports it in status", async () => {
    const ch = channel({ dbPath: join(dir, "nope", "chat.db") });
    await ch.poll();
    expect(ch.status()).toEqual({ ok: false, detail: expect.stringMatching(/no Messages database .* sign in/) });
    ch.stop();
  });

  it("sends plain text through Messages and explains a missing Automation permission", async () => {
    const ch = channel();
    await ch.send("imessage:me@icloud.com", "## Done\n**Deployed** the *api*. See [logs](https://x.example/l).");
    expect(sent).toEqual([["me@icloud.com", "Done\nDeployed the api. See logs (https://x.example/l)."]]);
    expect(ch.status()).toEqual({ ok: true });

    const denied = channel({
      sendRaw: async () => {
        throw Object.assign(new Error("Command failed"), { stderr: "execution error: Not authorized to send Apple events to Messages. (-1743)" });
      },
    });
    await expect(denied.send("imessage:me@icloud.com", "hi")).rejects.toThrow(/Automation, allow .* to control Messages/);
    expect(denied.status().ok).toBe(false);
  });
});

describe("attributedBody", () => {
  it("decodes short and long strings, and gives up on garbage", () => {
    expect(decodeAttributedBody(attributed("hi"))).toBe("hi");
    const long = "x".repeat(300) + " é";
    expect(decodeAttributedBody(attributed(long))).toBe(long);
    expect(decodeAttributedBody(Buffer.from("nothing here"))).toBeUndefined();
  });
});

describe("renderForIMessage", () => {
  it("drops emphasis markers but keeps list dashes, code and math", () => {
    expect(renderForIMessage("- *one*\n- two_words_here\n`npm test`\n2 * 3 * 4")).toEqual(["- one\n- two_words_here\n`npm test`\n2 * 3 * 4"]);
  });
});

describe("operators across channels", () => {
  it("one operator: an Apple ID email and the phone are aliases of the WhatsApp number", () => {
    const r = resolveOperators(["whatsapp", "imessage"], "+1 555 000 1111", "Me@iCloud.com");
    expect(r.operators).toEqual(["whatsapp:+15550001111"]);
    expect(r.aliases).toEqual({
      "whatsapp:+15550001111": "whatsapp:+15550001111",
      "imessage:+15550001111": "whatsapp:+15550001111",
      "imessage:me@icloud.com": "whatsapp:+15550001111",
    });
  });

  it("several operators: a handle must say whose it is", () => {
    expect(() => resolveOperators(["imessage"], "+15550001111,+15550002222", "a@x.com")).toThrow(/a@x.com=\+15551234567/);
    const r = resolveOperators(["imessage"], "+15550001111,+15550002222", "a@x.com=+15550002222");
    expect(r.aliases["imessage:a@x.com"]).toBe("whatsapp:+15550002222");
    expect(r.aliases["whatsapp:+15550001111"]).toBeUndefined(); // whatsapp is off
    expect(() => resolveOperators(["imessage"], "+15550001111", "a@x.com=+19999999999")).toThrow(/not in DISPATCH_OPERATORS/);
  });

  it("an email operator needs iMessage", () => {
    expect(resolveOperators(["imessage"], "boss@x.com", "").operators).toEqual(["imessage:boss@x.com"]);
    expect(() => resolveOperators(["whatsapp"], "boss@x.com", "")).toThrow(/only be an operator with the imessage channel/);
  });

  it("an iMessage-only box needs no Twilio and no public URL; iMessage needs macOS", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cfg-"));
    try {
      const env = { DISPATCH_STATE_DIR: dir, DISPATCH_CHANNELS: "imessage", DISPATCH_OPERATORS: "+15550001111", DISPATCH_PLATFORM: "darwin" } as NodeJS.ProcessEnv;
      const c = loadConfig(env);
      expect(c.channels).toEqual(["imessage"]);
      expect(c.twilio).toBeUndefined();
      expect(c.imessage?.dbPath).toMatch(/Library\/Messages\/chat\.db$/);
      expect(() => loadConfig({ ...env, DISPATCH_PLATFORM: "linux" })).toThrow(/needs macOS/);
      expect(() => loadConfig({ ...env, DISPATCH_CHANNELS: "telegram" })).toThrow(/unknown channel telegram/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pickAddress", () => {
  const aliases = {
    "whatsapp:+1555": "whatsapp:+1555",
    "imessage:+1555": "whatsapp:+1555",
    "imessage:me@icloud.com": "whatsapp:+1555",
  };
  const base = { operator: "whatsapp:+1555", aliases, up: ["whatsapp", "imessage"] as Array<"whatsapp" | "imessage">, whatsappWindowOpen: () => true };

  it("replies where the operator texted from last", () => {
    expect(pickAddress({ ...base, replyTo: "imessage:me@icloud.com" })).toBe("imessage:me@icloud.com");
    expect(pickAddress({ ...base, replyTo: "whatsapp:+1555" })).toBe("whatsapp:+1555");
  });

  it("moves to iMessage when WhatsApp's 24h window is closed, to the iMessage address used last", () => {
    expect(
      pickAddress({
        ...base,
        replyTo: "whatsapp:+1555",
        whatsappWindowOpen: () => false,
        lastInboundVia: { "imessage:+1555": "2026-01-01T00:00:00Z", "imessage:me@icloud.com": "2026-02-01T00:00:00Z" },
      }),
    ).toBe("imessage:me@icloud.com");
  });

  it("with no history prefers iMessage; with a channel down, uses what is up", () => {
    expect(pickAddress({ ...base })).toMatch(/^imessage:/);
    expect(pickAddress({ ...base, up: ["whatsapp"], replyTo: "imessage:me@icloud.com" })).toBe("whatsapp:+1555");
    expect(pickAddress({ ...base, up: [] })).toBeUndefined();
  });
});
