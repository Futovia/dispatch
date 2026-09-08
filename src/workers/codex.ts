import { Codex, type ThreadOptions, type UserInput, type ThreadEvent } from "@openai/codex-sdk";
import type { Worker, WorkerRunInput, WorkerResult } from "./types.js";
import { log } from "../log.js";

/**
 * OpenAI Codex via its SDK (a thin wrapper over the `codex` CLI, which uses
 * the ChatGPT login in ~/.codex/auth.json). One thread per operator, resumed
 * by id. Codex has no approval callback, so "ask" mode maps to the
 * workspace-write sandbox instead: writes stay inside the working directory.
 */
export class CodexWorker implements Worker {
  readonly name = "codex" as const;
  private codex = new Codex();

  async run(input: WorkerRunInput): Promise<WorkerResult> {
    const first = await this.attempt(input, input.resume);
    if (first.sessionLost && input.resume) {
      log.warn("codex thread could not be resumed, starting fresh", { resume: input.resume });
      const fresh = await this.attempt(input, undefined);
      return { ...fresh, sessionLost: true };
    }
    return first;
  }

  private async attempt(input: WorkerRunInput, resume: string | undefined): Promise<WorkerResult> {
    const auto = input.permissions === "auto";
    const opts: ThreadOptions = {
      workingDirectory: input.cwd,
      skipGitRepoCheck: true,
      sandboxMode: auto ? "danger-full-access" : "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      model: input.model,
    };
    const thread = resume ? this.codex.resumeThread(resume, opts) : this.codex.startThread(opts);

    // Codex takes no system prompt through the SDK; the context rides on the
    // first turn of a thread and lives in the transcript from then on.
    const text = resume ? input.prompt : `${input.systemPrompt}\n\n---\n\n${input.prompt}`;
    const items: UserInput[] = [{ type: "text", text }];
    for (const path of input.images) items.push({ type: "local_image", path });

    let threadId: string | undefined = resume;
    let lastText = "";
    let error: string | undefined;

    try {
      const { events } = await thread.runStreamed(items, { signal: input.signal });
      for await (const ev of events as AsyncIterable<ThreadEvent>) {
        switch (ev.type) {
          case "thread.started":
            threadId = ev.thread_id;
            input.onEvent({ kind: "status", text: "codex" });
            break;
          case "item.completed": {
            const item = ev.item;
            if (item.type === "agent_message" && item.text.trim()) {
              lastText = item.text;
              input.onEvent({ kind: "text", text: item.text });
            } else if (item.type === "command_execution") {
              input.onEvent({ kind: "tool", text: `$ ${item.command.slice(0, 300)}` });
            } else if (item.type === "file_change") {
              input.onEvent({ kind: "tool", text: `edit ${item.changes.map((c) => c.path).join(", ").slice(0, 200)}` });
            } else if (item.type === "error") {
              error = item.message;
            }
            break;
          }
          case "turn.failed":
            error = ev.error?.message ?? "turn failed";
            break;
          case "error":
            error = ev.message;
            break;
          default:
            break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (input.signal.aborted) return { text: "", sessionId: threadId, error: "aborted" };
      if (resume && /no (rollout|session|thread)|not found|could not resume|failed to resume/i.test(msg)) {
        return { text: "", sessionLost: true, error: msg };
      }
      log.error("codex run failed", { err: msg });
      return { text: lastText, sessionId: threadId, error: msg };
    }

    return { text: lastText, sessionId: threadId ?? thread.id ?? undefined, error };
  }
}
