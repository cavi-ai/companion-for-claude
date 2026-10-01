import { describe, expect, it } from "vitest";
import {
  migrateResearchModel, researchCoordinatorMode, researchModelChip, researchModelOptions, RESEARCH_MODELS,
} from "../../src/research/researchModel";

describe("researchCoordinatorMode", () => {
  it.each([["chat", "current"], ["claude", "claude"], ["local", "local"], ["off", "disabled"]] as const)("%s -> %s", (m, mode) => {
    expect(researchCoordinatorMode(m)).toBe(mode);
  });
  it("covers every model", () => expect(RESEARCH_MODELS).toHaveLength(4));
});

describe("migrateResearchModel", () => {
  it("narrator wins over reranker", () => {
    expect(migrateResearchModel({ intelligenceNarrator: "local", discoveryReranker: "claude" })).toBe("local");
  });
  it("skips current and falls to reranker", () => {
    expect(migrateResearchModel({ intelligenceNarrator: "current", discoveryReranker: "disabled" })).toBe("off");
  });
  it("ignores invalid values", () => {
    expect(migrateResearchModel({ intelligenceNarrator: "bogus", discoveryReranker: "claude" })).toBe("claude");
    expect(migrateResearchModel({ intelligenceNarrator: 3 })).toBeUndefined();
  });
  it("both current or absent -> undefined", () => {
    expect(migrateResearchModel({ intelligenceNarrator: "current", discoveryReranker: "current" })).toBeUndefined();
    expect(migrateResearchModel({})).toBeUndefined();
    expect(migrateResearchModel(null)).toBeUndefined();
  });
  it("keeps an existing valid researchModel", () => {
    expect(migrateResearchModel({ researchModel: "chat", intelligenceNarrator: "claude" })).toBeUndefined();
  });
  it("maps legacy over an invalid researchModel", () => {
    expect(migrateResearchModel({ researchModel: "x", intelligenceNarrator: "claude" })).toBe("claude");
  });
});

describe("researchModelChip", () => {
  const base = { providerLabel: "Claude Code", modelId: "sonnet", available: true };
  it("names provider and model", () => {
    expect(researchModelChip({ ...base, model: "chat" })).toEqual({ text: "AI · Claude Code · sonnet", available: true });
    expect(researchModelChip({ providerLabel: "Claude API", modelId: "m1", available: true, model: "claude" }).text).toBe("AI · Claude API · m1");
    expect(researchModelChip({ providerLabel: "Ollama", modelId: "llama", available: true, model: "local" }).text).toBe("AI · Ollama · llama");
  });
  it("off", () => expect(researchModelChip({ ...base, model: "off" })).toEqual({ text: "AI off", available: true }));
  it("unavailable", () => {
    expect(researchModelChip({ ...base, model: "chat", available: false })).toEqual({ text: "AI · set up Claude Code", available: false });
  });
});

describe("researchModelOptions", () => {
  it("labels", () => {
    expect(researchModelOptions({ providerLabel: "Codex", modelId: "gpt" }, { modelId: "qwen" })).toEqual({
      chat: "Same as chat — Codex · gpt", claude: "Claude API", local: "Local — qwen", off: "Off",
    });
  });
});
