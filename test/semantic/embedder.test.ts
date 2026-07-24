import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { OllamaEmbedder, embedderId, migrateEmbeddingEngine } from "../../src/semantic/embedder";
import { BUILTIN_EMBEDDING_MODEL } from "../../src/semantic/transformers/model";

describe("embedderId", () => {
  it("ollama keeps the raw model name — existing indexes stay valid", () => {
    expect(embedderId("ollama", "nomic-embed-text")).toBe("nomic-embed-text");
  });
  it("builtin uses the pinned prefixed id", () => {
    expect(embedderId("builtin", "nomic-embed-text")).toBe(BUILTIN_EMBEDDING_MODEL.id);
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

describe("worker bundle", () => {
  // CI runs typecheck→lint→test→build, so the artifact doesn't exist yet
  // there; local post-build runs assert esbuild pass 1 produced a sane bundle.
  const artifact = new URL("../../.build/embed-worker.txt", import.meta.url);
  it.skipIf(!existsSync(artifact))("esbuild pass 1 produced the inlined worker artifact", () => {
    const src = readFileSync(artifact, "utf8");
    // transformers.js is inside, not CDN-loaded — the bundle can't be tiny.
    expect(src.length).toBeGreaterThan(400_000);
    // Both prod (minified) and dev pass-1 outputs start with the strict-mode
    // pragma esbuild hoists out of the bundled ESM (verified empirically).
    expect(src.startsWith('"use strict";')).toBe(true);
    // esbuild must have lowered import.meta away — inside a Blob-URL iife
    // worker a surviving import.meta.url would be a runtime landmine.
    expect(src).not.toContain("import.meta");
  });
});
