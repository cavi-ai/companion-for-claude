import { describe, it, expect } from "vitest";
import { resolveModelId, modelLabel, CLAUDE_MODELS } from "../src/claude/models";

describe("resolveModelId", () => {
  it("prefers a non-empty custom id over the dropdown", () => {
    expect(resolveModelId("claude-sonnet-4-6", "my-snapshot-id")).toBe("my-snapshot-id");
  });
  it("falls back to the dropdown when custom is blank/whitespace", () => {
    expect(resolveModelId("claude-sonnet-4-6", "   ")).toBe("claude-sonnet-4-6");
    expect(resolveModelId("claude-opus-4-8", "")).toBe("claude-opus-4-8");
  });
});

describe("modelLabel", () => {
  it("returns the friendly label for known ids", () => {
    expect(modelLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });
  it("echoes unknown ids verbatim", () => {
    expect(modelLabel("claude-future-9")).toBe("claude-future-9");
  });
  it("has a label for every curated model", () => {
    for (const m of CLAUDE_MODELS) expect(modelLabel(m.id)).toBe(m.label);
  });
});
