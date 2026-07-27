import { describe, it, expect } from "vitest";
import { REWRITE_PRESETS, REWRITE_SYSTEM, buildRewriteUser, buildGroundedRewriteUser, rewriteMaxTokens, parseRewrite } from "../src/edit/rewrite";

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
