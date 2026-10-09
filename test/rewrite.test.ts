import { describe, it, expect } from "vitest";
import { REWRITE_PRESETS, REWRITE_SYSTEM, buildRewriteUser, buildGroundedRewriteUser, rewriteMaxTokens, parseRewrite, INSERT_SYSTEM, INSERT_CONTEXT_CHARS, buildInsertUser, parseInsert } from "../src/edit/rewrite";

describe("REWRITE_PRESETS", () => {
  it("offers the core set with unique ids and non-empty instructions", () => {
    const ids = REWRITE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of REWRITE_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.instruction.length).toBeGreaterThan(10);
    }
    expect(ids).toContain("improve");
    expect(ids).toContain("grammar");
  });
});

describe("buildRewriteUser", () => {
  it("embeds the instruction and the selection", () => {
    const user = buildRewriteUser("some **bold** text", "Make it shorter");
    expect(user).toContain("Instruction: Make it shorter");
    expect(user).toContain("some **bold** text");
  });
});

describe("buildGroundedRewriteUser", () => {
  it("embeds instruction, grounding context, and selection with a no-new-facts guard", () => {
    const user = buildGroundedRewriteUser("X causes Y", "Sharpen", "Evidence (supports) — Study A: excerpt");
    expect(user).toContain("Instruction: Sharpen");
    expect(user).toContain("Evidence (supports) — Study A: excerpt");
    expect(user).toContain("X causes Y");
    expect(user).toContain("introduce no new facts");
    expect(user.indexOf("Evidence (supports)")).toBeLessThan(user.indexOf("Text to rewrite:"));
  });
});

describe("rewriteMaxTokens", () => {
  it("has a floor for tiny selections", () => {
    expect(rewriteMaxTokens("hi")).toBe(600);
  });

  it("scales with selection length", () => {
    expect(rewriteMaxTokens("x".repeat(4000))).toBe(2000);
  });

  it("caps very long selections", () => {
    expect(rewriteMaxTokens("x".repeat(100000))).toBe(8000);
  });
});

describe("parseRewrite", () => {
  it("trims surrounding whitespace", () => {
    expect(parseRewrite("  rewritten text \n", "original")).toBe("rewritten text");
  });

  it("unwraps a whole-answer code fence when the original had none", () => {
    expect(parseRewrite("```markdown\nrewritten text\n```", "original")).toBe("rewritten text");
  });

  it("keeps fences when the original selection contained code fences", () => {
    const raw = "```\ncode\n```";
    expect(parseRewrite(raw, "original with ``` fence")).toBe(raw);
  });

  it("rejects an empty answer", () => {
    expect(() => parseRewrite("   ", "original")).toThrow(/empty rewrite/);
  });

  it("rejects a no-op answer", () => {
    expect(() => parseRewrite("original text", "original text")).toThrow(/unchanged/);
  });

  it("treats a whitespace-only difference as unchanged (a no-op edit)", () => {
    expect(() => parseRewrite("original text", "original text\n")).toThrow(/unchanged/);
  });
});

describe("REWRITE_SYSTEM", () => {
  it("instructs markdown preservation and bare output", () => {
    expect(REWRITE_SYSTEM).toContain("ONLY the rewritten text");
    expect(REWRITE_SYSTEM).toContain("[[...]]");
  });
});

describe("insert at the cursor", () => {
  it("system prompt asks for only the text to insert", () => {
    expect(INSERT_SYSTEM).toContain("ONLY the text to insert");
    expect(INSERT_SYSTEM).not.toBe(REWRITE_SYSTEM);
  });

  it("carries the instruction and the text on both sides of the cursor", () => {
    const user = buildInsertUser("Intro line.\n", "\nOutro line.", "add a summary");
    expect(user).toContain("Instruction: add a summary");
    expect(user).toContain("<before_cursor>\nIntro line.\n\n</before_cursor>");
    expect(user).toContain("<after_cursor>\n\nOutro line.\n</after_cursor>");
    expect(user.indexOf("Intro line.")).toBeLessThan(user.indexOf("Outro line."));
  });

  it("bounds the context to 2,000 characters before and 2,000 after the cursor", () => {
    expect(INSERT_CONTEXT_CHARS).toBe(2000);
    const before = "F" + "b".repeat(2000);
    const after = "a".repeat(2000) + "L";
    const user = buildInsertUser(before, after, "x");
    expect(user).toContain("b".repeat(2000));
    expect(user).toContain("a".repeat(2000));
    expect(user).not.toContain("F");
    expect(user).not.toContain("L");
    expect(user).not.toContain("b".repeat(2001));
    expect(user).not.toContain("a".repeat(2001));
  });

  it("parseInsert trims surrounding whitespace", () => {
    expect(parseInsert("\n\n  New paragraph.  \n")).toBe("New paragraph.");
  });

  it("parseInsert unwraps a whole-answer prose fence", () => {
    expect(parseInsert("```\nNew paragraph.\n```")).toBe("New paragraph.");
    expect(parseInsert("```markdown\n- one\n- two\n```")).toBe("- one\n- two");
    expect(parseInsert("```md\nText\n```")).toBe("Text");
  });

  it("parseInsert keeps a fence that names a code language", () => {
    expect(parseInsert("```python\nprint(1)\n```")).toBe("```python\nprint(1)\n```");
  });

  it("parseInsert rejects an empty reply, fenced or not", () => {
    expect(() => parseInsert("   \n")).toThrow(/nothing to insert/);
    expect(() => parseInsert("```\n\n```")).toThrow(/nothing to insert/);
  });
});

describe("insert context windows", () => {
  const lone = (s: string, at: number) => {
    const c = s.charCodeAt(at);
    return c >= 0xd800 && c <= 0xdfff;
  };
  const between = (user: string, tag: string) => user.slice(user.indexOf(`<${tag}>\n`) + tag.length + 3, user.indexOf(`\n</${tag}>`));

  it("never cut a surrogate pair at either edge", () => {
    const emoji = "😀";
    for (const pad of [0, 1]) {
      const before = emoji.repeat(INSERT_CONTEXT_CHARS) + "x".repeat(pad);
      const after = "x".repeat(pad) + emoji.repeat(INSERT_CONTEXT_CHARS);
      const user = buildInsertUser(before, after, "x");
      const b = between(user, "before_cursor");
      const a = between(user, "after_cursor");
      expect(lone(b, 0) && b.charCodeAt(0) >= 0xdc00).toBe(false);
      expect(lone(a, a.length - 1) && a.charCodeAt(a.length - 1) < 0xdc00).toBe(false);
      expect(b.length).toBeLessThanOrEqual(INSERT_CONTEXT_CHARS);
      expect(a.length).toBeLessThanOrEqual(INSERT_CONTEXT_CHARS);
    }
  });
});

describe("parseInsert fences", () => {
  it("unwraps a single text or plaintext fence", () => {
    expect(parseInsert("```text\nHello\n```")).toBe("Hello");
    expect(parseInsert("```plaintext\nHello\n```")).toBe("Hello");
  });

  it("inserts several fenced blocks as is", () => {
    const reply = "```\nA\n```\n\nThen:\n\n```\nB\n```";
    expect(parseInsert(reply)).toBe(reply);
  });

  it("keeps a code-language fence", () => {
    expect(parseInsert("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n```");
  });
});
