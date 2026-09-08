import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Worker, WorkerRunInput, WorkerResult } from "./types.js";
import { log } from "../log.js";

/**
 * Claude Code via the Agent SDK. Uses whatever login the `claude` CLI on this
 * box already has (a claude.ai subscription works; no API key required).
 * One SDK session per operator, resumed by id on every message.
 */
export class ClaudeWorker implements Worker {
  readonly name = "claude" as const;

  async run(input: WorkerRunInput): Promise<WorkerResult> {
    const first = await this.attempt(input, input.resume);
    if (first.sessionLost && input.resume) {
      log.warn("claude session could not be resumed, starting fresh", { resume: input.resume });
      const fresh = await this.attempt(input, undefined);
      return { ...fresh, sessionLost: true };
    }
    return first;
  }

  private async attempt(input: WorkerRunInput, resume: string | undefined): Promise<WorkerResult> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    input.signal.addEventListener("abort", onAbort, { once: true });

    const auto = input.permissions === "auto";
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      if (auto) return { behavior: "allow", updatedInput: toolInput };
      const ok = await input.approve({ tool: toolName, summary: summarize(toolName, toolInput) });
      return ok
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: "The operator declined this action from their phone. Continue without it or stop and explain.", interrupt: false };
    };

    let prompt = input.prompt;
    if (input.images.length) {
      prompt += `\n\n[Attached image${input.images.length > 1 ? "s" : ""}, read with the Read tool: ${input.images.join(", ")}]`;
    }

    // The SDK spawns the CLI. A daemon started from inside another Claude Code
    // session must not inherit its nesting guard.
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let sessionId: string | undefined;
    let lastText = "";
    let finalText = "";
    let costUsd: number | undefined;
    let turns: number | undefined;
    let error: string | undefined;

    try {
      const stream = query({
        prompt,
        options: {
          cwd: input.cwd,
          resume,
          abortController: ac,
          permissionMode: auto ? "bypassPermissions" : "default",
          allowDangerouslySkipPermissions: auto,
          canUseTool,
          systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt },
          settingSources: ["user", "project"],
          maxTurns: input.maxTurns,
          model: input.model,
          env: env as Record<string, string>,
        },
      });

      for await (const m of stream as AsyncIterable<SDKMessage>) {
        if (m.type === "system" && m.subtype === "init") {
          sessionId = m.session_id;
          input.onEvent({ kind: "status", text: `claude ${m.model}` });
        } else if (m.type === "assistant") {
          for (const block of m.message.content as unknown as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              lastText = block.text;
              input.onEvent({ kind: "text", text: block.text });
            } else if (block.type === "tool_use") {
              input.onEvent({
                kind: "tool",
                text: summarize(String(block.name), (block.input as Record<string, unknown>) ?? {}),
              });
            }
          }
        } else if (m.type === "result") {
          sessionId = m.session_id ?? sessionId;
          costUsd = m.total_cost_usd;
          turns = m.num_turns;
          if (m.subtype === "success") {
            finalText = m.result;
          } else {
            const errs = (m as { errors?: string[] }).errors ?? [];
            error = `${m.subtype}${errs.length ? ": " + errs.join("; ") : ""}`;
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (input.signal.aborted) return { text: "", sessionId, error: "aborted" };
      if (resume && /no conversation found|session.*not found|could not resume/i.test(msg)) {
        return { text: "", sessionLost: true, error: msg };
      }
      log.error("claude run failed", { err: msg });
      return { text: lastText, sessionId, error: msg };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }

    if (error && resume && /no conversation found|session.*not found/i.test(error)) {
      return { text: "", sessionLost: true, error };
    }
    return { text: finalText || lastText, sessionId, costUsd, turns, error };
  }
}

/** One line a human can approve from a phone. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown, n = 160) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);
  switch (tool) {
    case "Bash":
      return `$ ${s(input.command, 300)}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return `${tool} ${s(input.file_path ?? input.notebook_path)}`;
    case "Read":
      return `Read ${s(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `${tool} ${s(input.pattern)}`;
    case "WebFetch":
      return `WebFetch ${s(input.url)}`;
    case "WebSearch":
      return `WebSearch ${s(input.query)}`;
    case "Task":
    case "Agent":
      return `${tool} ${s(input.description)}`;
    default:
      return `${tool} ${s(JSON.stringify(input), 120)}`;
  }
}
