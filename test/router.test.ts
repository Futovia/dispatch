import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.js";
import { State } from "../src/state.js";
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
    const router = new Router({
      config: cfg,
      state,
      workers: { claude, codex },
      send: async (to, text) => {
        sent.push({ to, text });
      },
      forward: async (p) => {
        forwarded.push(p);
      },
      download: async () => Buffer.from("img"),
    });
    return { router, state };
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
