import { describe, it, expect } from "vitest";
import { OllamaEmbedder, embedderId, migrateEmbeddingEngine } from "../../src/semantic/embedder";
import { BUILTIN_EMBEDDING_MODEL } from "../../src/semantic/transformers/model";

describe("embedderId", () => {
  it("ollama keeps the raw model name — existing indexes stay valid", () => {
    expect(embedderId("ollama", "nomic-embed-text")).toBe("nomic-embed-text");
  });
  it("builtin uses the pinned prefixed id by default", () => {
    expect(embedderId("builtin", "nomic-embed-text")).toBe(BUILTIN_EMBEDDING_MODEL.id);
  });
  it("builtin honors the selected catalog model", () => {
    expect(embedderId("builtin", "nomic-embed-text", "builtin:snowflake-arctic-embed-m")).toBe("builtin:snowflake-arctic-embed-m");
    // Unknown selection falls back to the default, never a phantom index key.
    expect(embedderId("builtin", "nomic-embed-text", "builtin:nope")).toBe(BUILTIN_EMBEDDING_MODEL.id);
  });
  it("custom is prefixed so it can never collide with an ollama model name", () => {
    expect(embedderId("custom", "nomic-embed-text", undefined, "nomic-embed-text")).toBe("custom:nomic-embed-text");
    expect(embedderId("custom", "x", undefined, "  ")).toBe("custom:default");
  });
});

describe("migrateEmbeddingEngine", () => {
  it("keeps a pre-engine semantic user on ollama (their working setup)", () => {
    expect(migrateEmbeddingEngine({ semanticEnabled: true })).toBe("ollama");
  });
  it("undefined when semantic was never enabled — the builtin default applies", () => {
    expect(migrateEmbeddingEngine({ semanticEnabled: false })).toBeUndefined();
    expect(migrateEmbeddingEngine({})).toBeUndefined();
  });
  it("undefined when an engine is already stored — respect the user's choice", () => {
    expect(migrateEmbeddingEngine({ embeddingEngine: "builtin", semanticEnabled: true })).toBeUndefined();
    expect(migrateEmbeddingEngine({ embeddingEngine: "ollama", semanticEnabled: true })).toBeUndefined();
  });
  it("undefined for missing persisted settings (fresh install)", () => {
    expect(migrateEmbeddingEngine(null)).toBeUndefined();
  });
});

describe("OllamaEmbedder", () => {
  it("delegates to the injected embed fn with its model", async () => {
    const calls: Array<{ model: string; input: string[] }> = [];
    const e = new OllamaEmbedder("nomic-embed-text", (model, input) => {
      calls.push({ model, input });
      return Promise.resolve([[0.1]]);
    });
    expect(e.id).toBe("nomic-embed-text");
    await expect(e.embed(["hi"])).resolves.toEqual([[0.1]]);
    expect(calls).toEqual([{ model: "nomic-embed-text", input: ["hi"] }]);
  });
});

// The worker-bundle assertion lives in `tools/verify-worker-bundle.mjs`, run by
// CI after `pnpm run build`. It used to sit here behind skipIf(!existsSync(...)),
// but tests run before build, so it never executed in automation.
