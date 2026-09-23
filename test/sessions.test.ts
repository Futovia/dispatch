import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Sessions, ancestors, alive, stopProcess, modelFamily, sameModel, transcriptModel, type AgentInfo } from "../src/sessions.js";

let agentsList: AgentInfo[] = [];

describe("Sessions registry", () => {
  let dir: string;
  let children: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-sess-"));
  });
  afterEach(() => {
    for (const c of children) if (c.pid && alive(c.pid)) c.kill("SIGKILL");
    children = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function sleeper(): ChildProcess {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(c);
    return c;
  }

  it("tracks a session through the hook lifecycle", () => {
    const s = new Sessions(dir, { agents: () => agentsList });
    s.applyHook({ hook_event_name: "SessionStart", session_id: "abc-1", cwd: "/tmp/proj", transcript_path: "/x.jsonl" }, process.pid);
    expect(s.get("abc-1")?.state).toBe("idle");
    s.applyHook({ hook_event_name: "UserPromptSubmit", session_id: "abc-1", cwd: "/tmp/proj", prompt: "merge it\nplease" }, process.pid);
    expect(s.get("abc-1")).toMatchObject({ state: "busy", lastPrompt: "merge it" });
    s.applyHook({ hook_event_name: "Stop", session_id: "abc-1", cwd: "/tmp/proj" }, process.pid);
    expect(s.get("abc-1")?.state).toBe("idle");
    s.applyHook({ hook_event_name: "SessionEnd", session_id: "abc-1", cwd: "/tmp/proj" }, process.pid);
    expect(s.get("abc-1")?.state).toBe("ended");
    expect(s.list()).toHaveLength(0);
    expect(s.list({ includeEnded: true })).toHaveLength(1);
  });

  it("resolves targets by id prefix, path, basename and 'latest', and excludes own sessions", () => {
    const s = new Sessions(dir, { agents: () => agentsList });
    const live = sleeper();
    s.put({ id: "perfit-111", cwd: "/home/u/dev/perfit-app", pid: live.pid!, state: "idle", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    s.put({ id: "crm-222", cwd: "/home/u/dev/crm", pid: live.pid!, state: "idle", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" });
    s.put({ id: "root-333", cwd: "/home/u/dev", pid: live.pid!, state: "idle", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" });
    const own = ["root-333"];
    expect(s.resolve("perfit", own).map((r) => r.id)).toEqual(["perfit-111"]);
    expect(s.resolve("perfit-app", own).map((r) => r.id)).toEqual(["perfit-111"]);
    expect(s.resolve("/home/u/dev/crm/", own).map((r) => r.id)).toEqual(["crm-222"]);
    expect(s.resolve("crm-2", own).map((r) => r.id)).toEqual(["crm-222"]);
    expect(s.resolve("latest", own).map((r) => r.id)).toEqual(["crm-222"]);
    expect(s.resolve("dev", own).map((r) => r.id).sort()).toEqual(["crm-222", "perfit-111"]);
    expect(s.resolve("nothing-here", own)).toEqual([]);
  });

  it("marks sessions whose process died as ended", () => {
    const s = new Sessions(dir, { agents: () => agentsList });
    const c = sleeper();
    s.put({ id: "dead-1", cwd: "/tmp", pid: c.pid!, state: "idle", startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() });
    expect(s.list()).toHaveLength(1);
    c.kill("SIGKILL");
    return new Promise<void>((resolve) => {
      c.on("exit", () => {
        expect(s.list()).toHaveLength(0);
        expect(s.get("dead-1")?.state).toBe("ended");
        resolve();
      });
    });
  });

  it("finds the session a process belongs to through its ancestors", () => {
    const s = new Sessions(dir, { agents: () => agentsList });
    // Pretend our own parent is the claude CLI for this session.
    const parent = ancestors(process.pid)[0]!;
    s.put({ id: "mine-1", cwd: process.cwd(), pid: parent, state: "busy", startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() });
    expect(s.forPid(process.pid)?.id).toBe("mine-1");
    expect(s.forPid(process.pid, ["mine-1"])).toBeUndefined();
  });

  it("stopProcess terminates a live process", async () => {
    const c = sleeper();
    expect(alive(c.pid!)).toBe(true);
    expect(await stopProcess(c.pid!, 2000)).toBe(true);
    expect(alive(c.pid!)).toBe(false);
  });
});

describe("model names", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-model-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("matches aliases against full model ids", () => {
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
    expect(modelFamily("opus[1m]")).toBe("opus");
    expect(sameModel("opus", "claude-opus-5")).toBe(true);
    expect(sameModel("opus", "claude-opus-5[1m]")).toBe(true);
    expect(sameModel("opus", "claude-fable-5-1")).toBe(false);
    expect(sameModel("claude-haiku-4-5-20251001", "haiku")).toBe(true);
    expect(sameModel("some-custom-model", "some-custom-model")).toBe(true);
    expect(sameModel("some-custom-model", "other-model")).toBe(false);
  });

  it("reads the model a transcript last ran on, from the tail of the file", () => {
    const f = join(dir, "t.jsonl");
    const pad = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: "x", i })).join("\n");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1", content: [] } }),
        pad,
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [] } }),
        JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }),
      ].join("\n"),
    );
    expect(transcriptModel(f)).toBe("claude-opus-5");
    expect(transcriptModel(join(dir, "missing.jsonl"))).toBeUndefined();
    expect(transcriptModel(undefined)).toBeUndefined();
  });

  it("only looks at the tail, so a huge transcript costs nothing", () => {
    const f = join(dir, "big.jsonl");
    const old = JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1", content: [] } });
    writeFileSync(f, old + "\n" + "x".repeat(400 * 1024) + "\n");
    expect(transcriptModel(f)).toBeUndefined(); // beyond the tail window: not guessed at
  });
});
