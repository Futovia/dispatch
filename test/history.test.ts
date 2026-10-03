import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History, RESET } from "../src/history.js";
import { State } from "../src/state.js";

const OP = "whatsapp:+15550001111";

describe("History", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-history-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("imports the JSONL transcripts of an older install on first open, once", () => {
    mkdirSync(join(dir, "transcripts"));
    writeFileSync(
      join(dir, "transcripts", "15550001111.jsonl"),
      [
        JSON.stringify({ t: "2026-01-01T10:00:00.000Z", dir: "in", text: "hi", media: [] }),
        "{torn",
        JSON.stringify({ t: "2026-01-01T10:00:05.000Z", dir: "out", worker: "claude", text: "hello", costUsd: 0.01 }),
      ].join("\n") + "\n",
    );
    const state = new State(dir);
    state.transcript(OP, { dir: "in", text: "after upgrade" });
    expect(state.history.recent({ operator: OP }).map((e) => [e.at, e.dir, e.text])).toEqual([
      ["2026-01-01T10:00:00.000Z", "in", "hi"],
      ["2026-01-01T10:00:05.000Z", "out", "hello"],
      [expect.any(String), "in", "after upgrade"],
    ]);
    expect(state.history.recent({ operator: OP })[1]!.meta).toEqual({ costUsd: 0.01 });
    // reopening must not import again
    const again = new State(dir);
    expect(again.history.recent({ operator: OP })).toHaveLength(3);
  });

  it("searches literally and scopes catch-up to after the last reset", () => {
    const h = new History(":memory:");
    h.record(OP, { dir: "in", text: "100% done_ok" });
    h.record(OP, { dir: "in", text: "100 percent" });
    expect(h.recent({ search: "100%" }).map((e) => e.text)).toEqual(["100% done_ok"]);
    expect(h.recent({ search: "_" }).map((e) => e.text)).toEqual(["100% done_ok"]);

    h.record(OP, { dir: RESET });
    const a = h.record(OP, { dir: "in", text: "after" });
    h.record(OP, { dir: "in", text: "/status" });
    h.record(OP, { dir: "alert", text: "build failed" });
    h.record(OP, { dir: "out", text: "reply" });
    const b = h.record(OP, { dir: "in", text: "now" });
    expect(h.sinceReset(OP, 10, [b]).map((e) => e.text)).toEqual(["after", "reply"]);
    expect(h.sinceReset(OP, 1, [b]).map((e) => e.text)).toEqual(["reply"]);
    expect(a).toBeLessThan(b);
  });

  it("keeps pending texts per operator until cleared", () => {
    const h = new History(":memory:");
    const msg = (sid: string, body: string) => ({ sid, from: OP, to: "whatsapp:+1", body, media: [] });
    h.addPending(OP, { msg: msg("SM2", "b"), at: 2 });
    h.addPending(OP, { msg: msg("SM1", "a"), at: 1, historyId: 7 });
    expect(h.pending(OP).map((p) => [p.msg.body, p.historyId])).toEqual([
      ["a", 7],
      ["b", undefined],
    ]);
    expect(h.pendingOperators()).toEqual([OP]);
    h.clearPending(OP);
    expect(h.pending(OP)).toEqual([]);
  });
});
