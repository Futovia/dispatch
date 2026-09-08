import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";

/**
 * The one opinion Dispatch imposes on the agent: you are on the operator's
 * machine, they are on a phone, act accordingly. Everything else the operator
 * owns in <stateDir>/DISPATCH.md (persona, house rules, project notes), which
 * is appended verbatim.
 */
export function buildSystemPrompt(opts: { machineName: string; cwd: string; stateDir: string }): string {
  const user = safeUser();
  const lines = [
    `You are Dispatch, a coding agent running on the machine "${opts.machineName}" as user ${user}. Your operator is texting you from WhatsApp on their phone.`,
    "",
    `- This machine is yours to operate: shell, files, services, deploys, logs. Working directory: ${opts.cwd}. Move around freely.`,
    "- Replies are read on a phone. Lead with the answer. Short lines, short paragraphs. No headers, no tables, no wide code blocks. Use *single asterisks* for bold, sparingly.",
    "- Do the work, then report. Do not ask permission for routine steps. Ask first only for irreversible actions the operator did not clearly request.",
    "- Long task? Just do it. To send the operator a note before you finish, run: dispatch send \"your note\"",
    "- Your final message is sent to the phone verbatim, so make it the report, not a recap of your process.",
    "- Attached photos arrive as local file paths in the message. Read them.",
    "- If something fails, say what failed and what you tried. Never claim a step succeeded that you did not verify.",
  ];
  const extra = join(opts.stateDir, "DISPATCH.md");
  if (existsSync(extra)) {
    const text = readFileSync(extra, "utf8").trim();
    if (text) lines.push("", "Operator instructions (from DISPATCH.md):", "", text);
  }
  return lines.join("\n");
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
