import { describe, expect, it } from "vitest";
import { BUILTIN_EMBEDDING_MODELS, BUILTIN_EMBEDDING_MODEL, builtinIndexKey } from "../../src/semantic/transformers/model";
import { embedderId } from "../../src/semantic/embedder";
import { SemanticStore } from "../../src/semantic/store";

describe("built-in model download contracts", () => {
  it("pins the publisher revision and exact q8 assets", () => {
    expect(BUILTIN_EMBEDDING_MODEL.revision).toBe("d8c86521100d3556476a063fc2342036d45c106f");
    expect(BUILTIN_EMBEDDING_MODEL.dtype).toBe("q8");
    expect(BUILTIN_EMBEDDING_MODEL.assets).toContainEqual({ path: "onnx/model_quantized.onnx", bytes: 22_972_992 });
    for (const model of BUILTIN_EMBEDDING_MODELS) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.maxTokens).toBe(512);
      expect(model.assets.map((asset) => asset.path)).toEqual(["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]);
    }
  });

  it("does not reuse vectors whose downloaded revision was never recorded", () => {
    const key = embedderId("builtin", "ignored");
    expect(key).toContain("d8c86521100d3556476a063fc2342036d45c106f");
    expect(key).toContain("q8");
    const legacy = { version: 1, model: "builtin:snowflake-arctic-embed-xs", dim: 2, notes: { "A.md": { hash: "a", mtime: 1, chunks: [{ ord: 0, text: "Alpha", vector: [1, 0] }] } } };
    expect(SemanticStore.load(legacy, key).stats()).toEqual({ notes: 0, chunks: 0 });
  });

  it("invalidates the index when any encoding parameter changes", () => {
    const model = BUILTIN_EMBEDDING_MODEL;
    const original = builtinIndexKey(model);
    for (const change of [
      { hfRepo: "different/repo" }, { revision: "different" }, { pooling: "mean" as const },
      { dim: 768 }, { maxTokens: 256 }, { queryPrefix: "query: " }, { documentPrefix: "passage: " },
    ]) {
      expect(builtinIndexKey({ ...model, ...change })).not.toBe(original);
    }
  });
});
