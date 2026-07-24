import { describe, expect, it } from "vitest";
import { clearCachedModel, hasCachedModel, TRANSFORMERS_CACHE_NAME, type CachesLike } from "../../src/semantic/transformers/cache";
import { BUILTIN_EMBEDDING_MODEL } from "../../src/semantic/transformers/model";

const repo = BUILTIN_EMBEDDING_MODEL.hfRepo;
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.asyncify.wasm";
const ORT_MJS = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.asyncify.mjs";

function fakeCaches(urls: string[], opened: string[] = [], deleted: string[] = []): CachesLike {
  return {
    open: (name: string) => {
      opened.push(name);
      return Promise.resolve({
        keys: () => Promise.resolve(urls.filter((u) => !deleted.includes(u)).map((url) => ({ url }))),
        delete: (url: string) => {
          const hit = urls.includes(url) && !deleted.includes(url);
          if (hit) deleted.push(url);
          return Promise.resolve(hit);
        },
      });
    },
  };
}

describe("hasCachedModel", () => {
  it("true when the repo's onnx weights are cached", async () => {
    const opened: string[] = [];
    const caches = fakeCaches(
      [
        `https://huggingface.co/${repo}/resolve/main/config.json`,
        `https://huggingface.co/${repo}/resolve/main/onnx/model_quantized.onnx`,
      ],
      opened,
    );
    await expect(hasCachedModel(caches)).resolves.toBe(true);
    expect(opened).toEqual([TRANSFORMERS_CACHE_NAME]);
  });

  it("false for unrelated cached entries", async () => {
    const caches = fakeCaches(["https://huggingface.co/other/model/resolve/main/onnx/model.onnx", ORT_WASM]);
    await expect(hasCachedModel(caches)).resolves.toBe(false);
  });

  it("false when only non-weight repo files are cached (aborted download)", async () => {
    const caches = fakeCaches([`https://huggingface.co/${repo}/resolve/main/config.json`]);
    await expect(hasCachedModel(caches)).resolves.toBe(false);
  });

  it("false when the Cache API is unavailable", async () => {
    await expect(hasCachedModel(undefined)).resolves.toBe(false);
  });

  it("false when opening the cache throws", async () => {
    const caches: CachesLike = { open: () => Promise.reject(new Error("denied")) };
    await expect(hasCachedModel(caches)).resolves.toBe(false);
  });
});

describe("clearCachedModel", () => {
  it("deletes every repo entry and the ORT runtime assets, keeps other models", async () => {
    const otherModel = "https://huggingface.co/other/model/resolve/main/onnx/model.onnx";
    const deleted: string[] = [];
    const caches = fakeCaches(
      [
        `https://huggingface.co/${repo}/resolve/main/config.json`,
        `https://huggingface.co/${repo}/resolve/main/tokenizer.json`,
        `https://huggingface.co/${repo}/resolve/main/onnx/model_quantized.onnx`,
        ORT_WASM,
        ORT_MJS,
        otherModel,
      ],
      [],
      deleted,
    );
    await expect(clearCachedModel(caches)).resolves.toBe(5);
    expect(deleted).not.toContain(otherModel);
    expect(deleted).toHaveLength(5);
    // and the presence check flips back to false
    await expect(hasCachedModel(caches)).resolves.toBe(false);
  });

  it("0 when nothing of ours is cached", async () => {
    const caches = fakeCaches(["https://huggingface.co/other/model/resolve/main/onnx/model.onnx"]);
    await expect(clearCachedModel(caches)).resolves.toBe(0);
  });

  it("0 when the Cache API is unavailable", async () => {
    await expect(clearCachedModel(undefined)).resolves.toBe(0);
  });

  it("0 when opening the cache throws", async () => {
    const caches: CachesLike = { open: () => Promise.reject(new Error("denied")) };
    await expect(clearCachedModel(caches)).resolves.toBe(0);
  });
});
