import type { WorkerName, PermissionPolicy } from "../config.js";

/**
 * A worker is a coding agent we can hand a prompt and resume later. Two exist:
 * Claude Code and Codex. Dispatch adds no agent loop of its own: the frontier
 * labs ship a better harness every month, we route to it.
 */
export interface ApprovalRequest {
  tool: string;
  /** One-line human summary, e.g. the shell command or the file path. */
  summary: string;
}

export interface WorkerEvent {
  kind: "text" | "tool" | "status";
  text: string;
}

export interface WorkerRunInput {
  prompt: string;
  /** Local paths of images attached to the message. */
  images: string[];
  cwd: string;
  resume?: string;
  /** With `resume`: continue the transcript under a NEW session id, leaving the original untouched. */
  fork?: boolean;
  signal: AbortSignal;
  permissions: PermissionPolicy;
  systemPrompt: string;
  model?: string;
  maxTurns: number;
  onEvent: (e: WorkerEvent) => void;
  approve: (req: ApprovalRequest) => Promise<boolean>;
}

export interface WorkerResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  /** Set when the run ended abnormally; `text` then carries what we can tell the operator. */
  error?: string;
  /** The session could not be resumed (expired/corrupt); caller should drop the id. */
  sessionLost?: boolean;
}

export interface Worker {
  readonly name: WorkerName;
  run(input: WorkerRunInput): Promise<WorkerResult>;
}
