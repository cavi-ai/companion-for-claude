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
  it("never returns an empty id — falls back to a default when both are blank", () => {
    expect(resolveModelId("", "")).toBe(CLAUDE_MODELS[0]!.id);
    expect(resolveModelId("  ", "  ")).toBe(CLAUDE_MODELS[0]!.id);
  });
});

describe("modelLabel", () => {
  it("offers the current Opus 5 API model", () => {
    expect(CLAUDE_MODELS).toContainEqual(expect.objectContaining({ id: "claude-opus-5", label: "Claude Opus 5" }));
  });
  it("returns the friendly label for known ids", () => {
    expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
  });
  it("has a label for every curated model", () => {
    for (const m of CLAUDE_MODELS) expect(modelLabel(m.id)).toBe(m.label);
  });
});

describe("modelLabel formatting", () => {
  it("keeps catalog labels", () => {
    expect(modelLabel(CLAUDE_MODELS[0].id)).toBe(CLAUDE_MODELS[0].label);
  });
  it("formats unknown ids instead of leaking the slug", () => {
    expect(modelLabel("e2e-model")).toBe("E2e Model");
    expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Claude Opus 4 1");
    expect(modelLabel("qwen2.5-coder:7b")).toBe("Qwen2.5 Coder:7b");
    expect(modelLabel("meta/llama-3.1-8b")).toBe("Meta Llama 3.1 8b");
  });
  it("returns an empty id unchanged", () => {
    expect(modelLabel("")).toBe("");
  });
});
