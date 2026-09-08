/**
 * Agents write markdown. Phones show WhatsApp. This is the (deliberately small)
 * bridge: bold/italic/code survive, headers become bold lines, links become
 * "text (url)", tables become "a | b" rows, and long replies are split at
 * paragraph boundaries under Twilio's 1600-character WhatsApp limit.
 */
export const WA_MAX_CHARS = 1500;

export function toWhatsApp(md: string): string {
  let text = md.replace(/\r\n/g, "\n");

  // Fenced code stays verbatim; protect it while we rewrite everything else.
  const fences: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m.replace(/```\w*\n?/, "```").replace(/\n?```$/, "```"));
    return `@@FENCE${fences.length - 1}@@`;
  });

  text = text
    // headers -> bold line
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_m, h: string) => `*${stripInline(h)}*`)
    // **bold** / __bold__ -> *bold*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    // [text](url) -> text (url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    // table separator rows vanish, other rows become "a | b"
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(?:\n|$)/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
      row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(" | "),
    )
    // "- item" and "* item" -> "- item" (WhatsApp renders neither as a list; keep the dash)
    .replace(/^([ \t]*)\*[ \t]+(?!\[)/gm, "$1- ")
    // horizontal rules and stray blockquote markers
    .replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/^>[ \t]?/gm, "")
    // collapse 3+ blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  text = text.replace(/@@FENCE(\d+)@@/g, (_m, i: string) => fences[Number(i)] ?? "");
  return text;
}

function stripInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").trim();
}

/** Split at paragraph, then line, then word, then hard boundaries. */
export function chunk(text: string, max = WA_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = lastIndexBefore(rest, "\n\n", max);
    if (cut < max * 0.4) cut = lastIndexBefore(rest, "\n", max);
    if (cut < max * 0.4) cut = lastIndexBefore(rest, " ", max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function lastIndexBefore(s: string, needle: string, limit: number): number {
  const i = s.lastIndexOf(needle, limit);
  return i <= 0 ? -1 : i;
}

/** Full pipeline: markdown in, WhatsApp-sized messages out. */
export function renderForWhatsApp(md: string): string[] {
  const text = toWhatsApp(md);
  return text ? chunk(text) : [];
}
