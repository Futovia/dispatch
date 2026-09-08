import { describe, it, expect } from "vitest";
import { toWhatsApp, chunk, renderForWhatsApp } from "../src/wa-format.js";

describe("toWhatsApp", () => {
  it("turns markdown into WhatsApp formatting", () => {
    const md = "# Title\n\nSome **bold** and [a link](https://x.y/z).\n\n* one\n* two\n\n---\n> quoted";
    expect(toWhatsApp(md)).toBe("*Title*\n\nSome *bold* and a link (https://x.y/z).\n\n- one\n- two\n\nquoted");
  });

  it("flattens tables and keeps code fences verbatim", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n\n```bash\nls **not bold**\n```";
    expect(toWhatsApp(md)).toBe("a | b\n1 | 2\n\n```ls **not bold**```");
  });
});

describe("chunk", () => {
  it("returns short text untouched", () => {
    expect(chunk("hello", 100)).toEqual(["hello"]);
  });

  it("prefers paragraph breaks, then lines, then words", () => {
    const paras = ["a".repeat(60), "b".repeat(60), "c".repeat(60)].join("\n\n");
    expect(chunk(paras, 130)).toEqual(["a".repeat(60) + "\n\n" + "b".repeat(60), "c".repeat(60)]);
    const words = Array(50).fill("word").join(" ");
    for (const part of chunk(words, 40)) expect(part.length).toBeLessThanOrEqual(40);
    expect(chunk(words, 40).join(" ")).toBe(words);
  });

  it("hard-splits a single giant token", () => {
    expect(chunk("x".repeat(250), 100).map((s) => s.length)).toEqual([100, 100, 50]);
  });
});

describe("renderForWhatsApp", () => {
  it("drops empty output", () => {
    expect(renderForWhatsApp("   \n")).toEqual([]);
  });
});
