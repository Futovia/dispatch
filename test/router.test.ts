import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.js";
import { State } from "../src/state.js";
import { Sessions } from "../src/sessions.js";
import type { Config } from "../src/config.js";
import type { Worker, WorkerRunInput, WorkerResult } from "../src/workers/types.js";

const OP = "whatsapp:+15550001111";
const STRANGER = "whatsapp:+15559999999";

function config(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    stateDir: dir,
    envFile: join(dir, "env"),
    host: "127.0.0.1",
    port: 0,
    publicUrl: "https://d.example",
    webhookPath: "/twilio/whatsapp",
    twilio: { accountSid: "AC", authToken: "tok", from: "whatsapp:+14155238886" },
    operators: [OP],
    workspace: dir,
    defaultWorker: "claude",
    permissions: "auto",
    maxTurns: 10,
    jobTimeoutMs: 60_000,
    approvalTimeoutMs: 1_000,
    machineName: "testbox",
    tellIdleWaitMs: 200,
    tellTimeoutMs: 10_000,
    ...overrides,
  };
}

class FakeWorker implements Worker {
  calls: WorkerRunInput[] = [];
  reply: (input: WorkerRunInput) => Promise<WorkerResult> = async (i) => ({ text: `echo: ${i.prompt}`, sessionId: `${this.name}-sess` });
  constructor(readonly name: "claude" | "codex") {}
  async run(input: WorkerRunInput): Promise<WorkerResult> {
    this.calls.push(input);
    return this.reply(input);
  }
}

function inbound(from: string, body: string, sid = `SM${Math.random().toString(36).slice(2)}`): Record<string, string> {
  return { MessageSid: sid, From: from, To: "whatsapp:+14155238886", Body: body, NumMedia: "0" };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("Router", () => {
  let dir: string;
  let sent: Array<{ to: string; text: string }>;
  let forwarded: Record<string, string>[];
  let claude: FakeWorker;
  let codex: FakeWorker;

  function make(overrides: Partial<Config> = {}) {
    const cfg = config(dir, overrides);
    const state = new State(dir);
    const sessions = new Sessions(dir);
    const router = new Router({
      config: cfg,
      state,
      sessions,
      workers: { claude, codex },
      send: async (to, text) => {
        sent.push({ to, text });
      },
      forward: async (p) => {
        forwarded.push(p);
      },
      download: async () => Buffer.from("img"),
    });
    return { router, state, sessions };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    sent = [];
    forwarded = [];
    claude = new FakeWorker("claude");
    codex = new FakeWorker("codex");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("routes operator text to the worker, resumes the session next time", async () => {
    const { router, state } = make();
    await router.handleWebhook(inbound(OP, "hello"));
    await tick();
    expect(sent).toEqual([{ to: OP, text: "echo: hello" }]);
    expect(claude.calls[0]!.resume).toBeUndefined();
    expect(state.operator(OP, { worker: "claude", cwd: dir }).sessions.claude).toBe("claude-sess");

    await router.handleWebhook(inbound(OP, "again"));
    await tick();
    expect(claude.calls[1]!.resume).toBe("claude-sess");
  });

  it("ignores a Twilio retry of the same MessageSid", async () => {
    const { router } = make();
    await router.handleWebhook(inbound(OP, "once", "SM-same"));
    await router.handleWebhook(inbound(OP, "once", "SM-same"));
    await tick();
    expect(claude.calls).toHaveLength(1);
  });

  it("queues messages while a job runs and runs them after", async () => {
    const { router } = make();
    let release!: () => void;
    claude.reply = (i) =>
      new Promise((resolve) => {
        if (i.prompt === "slow") release = () => resolve({ text: "slow done" });
        else resolve({ text: `echo: ${i.prompt}` });
      });
    await router.handleWebhook(inbound(OP, "slow"));
    await tick();
    await router.handleWebhook(inbound(OP, "second"));
    await router.handleWebhook(inbound(OP, "third"));
    expect(sent.map((s) => s.text)).toEqual(["got it, queued behind the current task. /stop to cancel that one."]);
    release();
    await tick();
    await tick();
    expect(sent.map((s) => s.text)).toEqual([
      "got it, queued behind the current task. /stop to cancel that one.",
      "slow done",
      "echo: second\n\nthird",
    ]);
  });

  it("/stop aborts the running job", async () => {
    const { router } = make();
    claude.reply = (i) =>
      new Promise((resolve) => {
        i.signal.addEventListener("abort", () => resolve({ text: "", error: "aborted" }));
      });
    await router.handleWebhook(inbound(OP, "forever"));
    await tick();
    await router.handleWebhook(inbound(OP, "/stop"));
    await tick();
    expect(sent.map((s) => s.text)).toEqual(["stopping claude.", "stopped."]);
  });

  it("switches workers and keeps a session per worker", async () => {
    const { router } = make();
    await router.handleWebhook(inbound(OP, "one"));
    await tick();
    await router.handleWebhook(inbound(OP, "/codex"));
    await router.handleWebhook(inbound(OP, "two"));
    await tick();
    expect(codex.calls[0]!.prompt).toBe("two");
    await router.handleWebhook(inbound(OP, "/claude"));
    expect(sent.at(-1)!.text).toBe("switched to claude, resuming your last session.");
    await router.handleWebhook(inbound(OP, "three"));
    await tick();
    expect(claude.calls[1]!.resume).toBe("claude-sess");
  });

  it("/new drops the session, /cd changes the folder, /status reports", async () => {
    const { router } = make();
    await router.handleWebhook(inbound(OP, "x"));
    await tick();
    await router.handleWebhook(inbound(OP, "/new"));
    await router.handleWebhook(inbound(OP, "y"));
    await tick();
    expect(claude.calls[1]!.resume).toBeUndefined();

    await router.handleWebhook(inbound(OP, "/cd /definitely/not/here"));
    expect(sent.at(-1)!.text).toMatch(/no such folder/);
    await router.handleWebhook(inbound(OP, `/cd ${tmpdir()}`));
    await router.handleWebhook(inbound(OP, "z"));
    await tick();
    expect(claude.calls[2]!.cwd).toBe(tmpdir());

    await router.handleWebhook(inbound(OP, "/status"));
    expect(sent.at(-1)!.text).toMatch(/agent: claude \(auto\)/);
    expect(sent.at(-1)!.text).toMatch(/idle/);
  });

  it("passes text starting with a slash but not a command to the agent", async () => {
    const { router } = make();
    await router.handleWebhook(inbound(OP, "/etc/hosts looks wrong, check it"));
    await tick();
    expect(claude.calls[0]!.prompt).toBe("/etc/hosts looks wrong, check it");
  });

  it("relays approvals in ask mode and answers plain yes/no", async () => {
    const { router } = make({ permissions: "ask" });
    claude.reply = async (i) => {
      const ok = await i.approve({ tool: "Bash", summary: "$ rm -rf build" });
      return { text: ok ? "removed" : "kept" };
    };
    await router.handleWebhook(inbound(OP, "clean"));
    await tick();
    expect(sent.at(-1)!.text).toBe("approve?\n$ rm -rf build\n\nyes / no");
    await router.handleWebhook(inbound(OP, "yes"));
    await tick();
    expect(sent.at(-1)!.text).toBe("removed");
  });

  it("denies an approval nobody answers", async () => {
    const { router } = make({ permissions: "ask", approvalTimeoutMs: 20 });
    claude.reply = async (i) => ({ text: (await i.approve({ tool: "Bash", summary: "$ x" })) ? "yes" : "denied" });
    await router.handleWebhook(inbound(OP, "go"));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.at(-1)!.text).toBe("denied");
  });

  it("forwards strangers when a fallthrough is configured, and /fwd for operators", async () => {
    const { router } = make({
      fallthrough: { url: "http://127.0.0.1:8787/hook", signedUrl: "https://old.example/hook", command: "beck" },
    });
    await router.handleWebhook(inbound(STRANGER, "hi there"));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.Body).toBe("hi there");
    expect(claude.calls).toHaveLength(0);

    await router.handleWebhook(inbound(OP, "/beck remind me tomorrow"));
    expect(forwarded[1]!.Body).toBe("remind me tomorrow");
    expect(forwarded[1]!.From).toBe(OP);
  });

  it("stays silent to strangers by default, replies once per hour when told to", async () => {
    const { router } = make();
    await router.handleWebhook(inbound(STRANGER, "hello?"));
    expect(sent).toHaveLength(0);
    expect(forwarded).toHaveLength(0);

    const { router: r2 } = make({ fallthroughReply: "private line." });
    await r2.handleWebhook(inbound(STRANGER, "hello?"));
    await r2.handleWebhook(inbound(STRANGER, "hello??"));
    expect(sent).toEqual([{ to: STRANGER, text: "private line." }]);
  });

  it("downloads images and hands paths to the worker", async () => {
    const { router } = make();
    await router.handleWebhook({
      ...inbound(OP, "what is this"),
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/m/1",
      MediaContentType0: "image/jpeg",
    });
    await tick();
    expect(claude.calls[0]!.images).toHaveLength(1);
    expect(claude.calls[0]!.images[0]).toMatch(/\.jpg$/);
  });

  it("starts fresh when the worker reports the session was lost", async () => {
    const { router, state } = make();
    await router.handleWebhook(inbound(OP, "a"));
    await tick();
    claude.reply = async () => ({ text: "fresh", sessionId: "claude-new", sessionLost: true });
    await router.handleWebhook(inbound(OP, "b"));
    await tick();
    expect(sent.at(-1)!.text).toMatch(/previous session was gone/);
    expect(state.operator(OP, { worker: "claude", cwd: dir }).sessions.claude).toBe("claude-new");
  });
});

describe("Router: alerts and tell", () => {
  let dir: string;
  let sent: Array<{ to: string; text: string }>;
  let claude: FakeWorker;
  let codex: FakeWorker;

  function make(overrides: Partial<Config> = {}) {
    const cfg = config(dir, overrides);
    const state = new State(dir);
    const sessions = new Sessions(dir);
    const router = new Router({
      config: cfg,
      state,
      sessions,
      workers: { claude, codex },
      send: async (to, text) => {
        sent.push({ to, text });
      },
      forward: async () => undefined,
      download: async () => Buffer.from("img"),
    });
    return { router, state, sessions };
  }

  function liveProcess() {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    procs.push(c);
    return c;
  }
  const procs: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    sent = [];
    claude = new FakeWorker("claude");
    codex = new FakeWorker("codex");
  });
  afterEach(() => {
    for (const c of procs) if (c.pid) try { c.kill("SIGKILL"); } catch { /* gone */ }
    procs.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it("alert: texts the operator tagged with the session folder, then feeds it into the next prompt", async () => {
    const { router, sessions } = make();
    const p = liveProcess();
    sessions.put({ id: "perfit-abc", cwd: join(dir, "perfit-app"), pid: p.pid!, state: "idle", startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() });
    const out = await router.alert({ text: "pr done", sessionId: "perfit-abc" });
    expect(out.delivered).toBe(true);
    expect(out.sessionId).toBe("perfit-abc");
    expect(sent).toEqual([{ to: OP, text: "*perfit-app*\npr done" }]);

    await router.handleWebhook(inbound(OP, "pls merge"));
    await tick();
    const prompt = claude.calls[0]!.prompt;
    expect(prompt).toContain("alert from session perfit-a");
    expect(prompt).toContain("pr done");
    expect(prompt.endsWith("pls merge")).toBe(true);

    // Notes are drained: the next message carries none.
    await router.handleWebhook(inbound(OP, "thanks"));
    await tick();
    expect(claude.calls[1]!.prompt).toBe("thanks");
  });

  it("alert: from a plain script (no session) is tagged with its folder", async () => {
    const { router } = make();
    await router.alert({ text: "backup finished", cwd: "/srv/backups" });
    expect(sent).toEqual([{ to: OP, text: "*backups*\nbackup finished" }]);
    await router.alert({ text: "no folder" });
    expect(sent[1]).toEqual({ to: OP, text: "no folder" });
  });

  it("alert: from dispatch's own root session is passed through without a note", async () => {
    const { router, state, sessions } = make();
    state.operator(OP, { worker: "claude", cwd: dir });
    state.setSession(OP, "claude", "root-sess");
    sessions.put({ id: "root-sess", cwd: dir, pid: process.pid, state: "busy", startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() });
    await router.alert({ text: "halfway there", sessionId: "root-sess" });
    expect(sent).toEqual([{ to: OP, text: "halfway there" }]);
    expect(state.takeNotes(OP)).toEqual([]);
  });

  it("tell: stops an idle terminal session and resumes the same id headlessly", async () => {
    const { router, sessions, state } = make();
    const p = liveProcess();
    const cwd = join(dir, "perfit-app");
    sessions.put({ id: "perfit-abc", cwd, pid: p.pid!, state: "idle", startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() });
    claude.reply = async (i) => ({ text: "merged 4f1c2a9", sessionId: i.resume });

    const job = router.tell("perfit", "merge the pr");
    const result = await job.done;
    expect(result).toMatchObject({ ok: true, mode: "resume", text: "merged 4f1c2a9", sessionId: "perfit-abc" });
    expect(claude.calls[0]).toMatchObject({ resume: "perfit-abc", fork: false, cwd, permissions: "auto" });
    expect(claude.calls[0]!.prompt).toContain("merge the pr");
    expect(p.exitCode !== null || p.signalCode !== null || p.killed).toBe(true);
    expect(sessions.get("perfit-abc")).toMatchObject({ state: "taken", pid: 0 });
    expect(sent).toEqual([{ to: OP, text: "*perfit-app*\nmerged 4f1c2a9" }]);
    expect(state.takeNotes(OP)[0]).toContain("merged 4f1c2a9");
  });

  it("tell: forks instead when the session stays busy", async () => {
    const { router, sessions } = make();
    const p = liveProcess();
    sessions.put({ id: "crm-222", cwd: join(dir, "crm"), pid: p.pid!, state: "busy", startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() });
    claude.reply = async () => ({ text: "deployed", sessionId: "crm-222-fork" });
    const result = await router.tell("crm", "deploy it", { notify: false }).done;
    expect(result.mode).toBe("fork");
    expect(claude.calls[0]).toMatchObject({ resume: "crm-222", fork: true });
    expect(p.exitCode).toBeNull(); // the terminal session was left alone
    expect(sessions.get("crm-222")).toMatchObject({ state: "busy", continuedAs: "crm-222-fork" });
    expect(sent).toEqual([]);
  });

  it("tell: refuses ambiguous targets, unknown targets, and dispatch's own session", async () => {
    const { router, sessions, state } = make();
    const p = liveProcess();
    const base = { pid: p.pid!, state: "idle" as const, startedAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString() };
    sessions.put({ id: "a-1", cwd: "/x/dev/one", ...base });
    sessions.put({ id: "a-2", cwd: "/x/dev/two", ...base });
    sessions.put({ id: "root-1", cwd: "/x/dev", ...base });
    state.operator(OP, { worker: "claude", cwd: dir });
    state.setSession(OP, "claude", "root-1");
    expect(() => router.tell("a-", "x")).toThrow(/ambiguous/);
    expect(() => router.tell("nope", "x")).toThrow(/no live terminal session/);
    expect(() => router.tell("root-1", "x")).toThrow(/no live terminal session/);
    expect(router.listSessions().map((s) => s.id).sort()).toEqual(["a-1", "a-2"]);
  });
});
