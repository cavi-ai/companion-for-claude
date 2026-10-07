// The embedding worker: hosts transformers.js so tokenization + inference
// never block Obsidian's UI thread. Self-contained — esbuild bundles this
// file (transformers.js included) into a text artifact that main.ts turns
// into a Blob-URL worker. NOTHING here fetches the network until the first
// "load" request, which only ever arrives from an explicit user action —
// importing @huggingface/transformers just sets config defaults (verified
// against the 4.2.0 source: env.js / backends/onnx.js fetch nothing at
// import; they only write the default wasmPaths URLs into ORT's env).
//
// Network + caching (verified against @huggingface/transformers@4.2.0):
// - Model weights/tokenizer download from huggingface.co on the first "load"
//   and are cached in the Cache API ("transformers-cache", env.useBrowserCache).
// - ONNX-runtime's sidecar binaries (ort-wasm-simd-threaded.asyncify.{mjs,wasm})
//   resolve to cdn.jsdelivr.net by default; env.useWasmCache makes the library
//   fetch them once during the same consented load and cache them in the same
//   Cache API bucket, so every later load is fully offline. Inlining them into
//   this bundle instead was rejected: the .wasm alone is ~23 MB (~31 MB as
//   base64), which would balloon main.js for every user, downloaded or not.

import "./forceWebEnv"; // MUST precede the transformers import — see that file
import { pipeline, env } from "@huggingface/transformers";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { TRANSFORMERS_CACHE_NAME } from "./cache";
import { handleDeviceRequest } from "../../device/worker";
import type { DeviceWorkerRequest, DeviceWorkerResponse } from "../../device/protocol";

// Enforce consent at the network boundary, including ORT sidecars. A partial
// cache must fail closed instead of silently downloading missing assets.
const networkFetch = globalThis.fetch.bind(globalThis);
let allowNetwork = false;
const guardedFetch: typeof fetch = async (input, init) => {
  if (allowNetwork) return networkFetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  const cached = typeof caches === "undefined" ? undefined : await (await caches.open(TRANSFORMERS_CACHE_NAME)).match(url);
  if (cached) return cached;
  throw new Error("Embedding assets missing from cache — download the model in Companion settings.");
};
globalThis.fetch = guardedFetch;
env.fetch = guardedFetch;

// The dedicated-worker global, narrowed to what this file uses. (A plain
// `declare const self` would collide with lib.dom's declaration.)
const ctx = self as unknown as {
  onmessage: ((e: { data: WorkerRequest | DeviceWorkerRequest }) => void) | null;
  postMessage(msg: WorkerResponse | DeviceWorkerResponse): void;
};

env.allowLocalModels = false; // hub + cache only; never probe local /models/ paths
if (typeof caches !== "undefined") {
  env.useBrowserCache = true; // weights cached in the Cache API
  env.useWasmCache = true; // ORT wasm binary + mjs factory cached alongside them
}
// Single-threaded WASM: ORT's multithreaded path spawns nested workers from
// import.meta.url, which doesn't exist inside this Blob-URL iife bundle.
const onnxEnv = env.backends.onnx as { wasm?: { numThreads?: number } };
if (onnxEnv.wasm) onnxEnv.wasm.numThreads = 1;

/** The feature-extraction pipeline: callable, plus dispose to free ORT sessions. */
type ModelContract = Omit<Extract<WorkerRequest, { type: "load" }>, "id" | "type" | "allowDownload">;

interface Extractor {
  (texts: string[], opts: { pooling: "cls" | "mean"; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
  tokenizer: { config: { model_max_length?: number } };
  dispose?: () => Promise<void>;
}

let extractor: Extractor | null = null;
let backend = "wasm";
/** In-flight pipeline construction, memoized so concurrent "load" requests share it. */
let loading: Promise<void> | null = null;
/** Bumped by "dispose" so an in-flight load can tell it was cancelled. */
let generation = 0;
/** The loaded model's config (set on load; embed uses its pooling). */
let active: ModelContract | null = null;
let loadingContract: ModelContract | null = null;
/** Set when a WebGPU session dies after a successful warm-up (device lost);
 * the warm-up probe can't catch that, so skip WebGPU from then on. */
let webgpuBroken = false;
/** In-flight wasm rebuild after a WebGPU device loss; concurrent embeds whose
 * dead-session inference fails await this instead of racing a second rebuild. */
let rebuilding: Promise<void> | null = null;

async function hasWebGpuAdapter(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
  try {
    return (await navigator.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function makeExtractor(device: "webgpu" | "wasm", id: number, model: ModelContract): Promise<Extractor> {
  // Hub progress events carry {status:"progress", file, progress: 0-100};
  // other statuses (initiate/download/done/ready) have no progress field.
  const progress = (p: unknown) => {
    const info = p as { progress?: number; file?: string };
    if (typeof info.progress === "number") {
      ctx.postMessage({ id, type: "progress", percent: Math.round(info.progress), file: info.file ?? "" });
    }
  };
  // q8 → onnx/model_quantized.onnx (verified present in the catalog repos).
  const candidate: Extractor = await pipeline("feature-extraction", model.repo, {
    device,
    dtype: model.dtype,
    revision: model.revision,
    progress_callback: progress,
  });
  // FeatureExtractionPipeline ignores max_length in its call options. Its
  // tokenizer truncates against this public config instead (Transformers 4.3).
  candidate.tokenizer.config.model_max_length = model.maxTokens;
  return candidate;
}

async function doLoad(id: number, model: ModelContract): Promise<void> {
  if (!allowNetwork) {
    // ORT may import its factory URL directly after a failed preload, bypassing
    // fetch. Require its exact current sidecars before constructing the session.
    const paths = (env.backends.onnx as { wasm?: { wasmPaths?: { wasm?: string; mjs?: string } } }).wasm?.wasmPaths;
    for (const url of [paths?.wasm, paths?.mjs]) {
      if (url && !url.startsWith("blob:")) await guardedFetch(url);
    }
  }
  const gen = generation;
  let candidate: Extractor | null = null;
  let chosen = "wasm";
  const poolingOpts = { pooling: model.pooling, normalize: true } as const;
  // pipeline() throws synchronously-via-rejection when navigator.gpu is
  // missing ("Unsupported device"), but some WebGPU failures only surface at
  // session creation or first inference — probe the API up front, then verify
  // with a warm-up inference before committing to the backend. Weights are
  // already cached by then, so the wasm fallback re-load is offline.
  if (!webgpuBroken && await hasWebGpuAdapter()) {
    let webgpu: Extractor | null = null;
    try {
      webgpu = await makeExtractor("webgpu", id, model);
      await webgpu(["warm-up"], poolingOpts);
      candidate = webgpu;
      chosen = "webgpu";
    } catch {
      webgpuBroken = true;
      try {
        await webgpu?.dispose?.();
      } catch {
        // Disposal is best-effort; construction may have failed before a live
        // session existed. Do not overlap a known live session with WASM.
      }
    }
  }
  if (!candidate) {
    candidate = await makeExtractor("wasm", id, model);
  }
  if (gen !== generation) {
    // "dispose" arrived while we were loading: don't resurrect the pipeline.
    void candidate.dispose?.()?.catch(() => {});
    throw new Error("disposed during load");
  }
  extractor = candidate;
  backend = chosen;
  active = model;
}

function sameContract(a: ModelContract | null, b: ModelContract): boolean {
  return a?.repo === b.repo && a.revision === b.revision && a.dtype === b.dtype
    && a.pooling === b.pooling && a.maxTokens === b.maxTokens && a.dim === b.dim;
}

async function load(id: number, model: ModelContract): Promise<void> {
  if (loading && !extractor && !sameContract(loadingContract, model)) throw new Error("Another embedding model is already loading");
  // A load for a different model than the loaded one swaps the pipeline out.
  if (extractor && !sameContract(active, model)) {
    generation++;
    await extractor.dispose?.();
    extractor = null;
    loading = null;
    active = null;
  }
  if (!extractor) {
    // Memoize the in-flight construction: a second "load" while the first is
    // still running must not build a second pipeline (that would leak the
    // first ORT session). Only the initiating request streams progress
    // events — later joiners just await the shared promise and post their
    // own result by id.
    if (!loading) {
      loadingContract = model;
      const p = doLoad(id, model).catch((e: unknown) => {
        if (loading === p) loading = null; // allow retry after a failed load
        throw e;
      });
      loading = p;
    }
    await loading;
  }
  ctx.postMessage({ id, type: "result", vectors: [], backend });
}

async function embed(id: number, texts: string[]): Promise<void> {
  // A wasm rebuild after a WebGPU device loss leaves extractor null while it
  // runs; wait it out instead of misreporting "model not loaded".
  if (!extractor && rebuilding) await rebuilding.catch(() => {});
  if (!extractor || !active) {
    ctx.postMessage({ id, type: "error", message: "model not loaded" });
    return;
  }
  const opts = { pooling: active.pooling, normalize: true } as const;
  try {
    const out = await extractor(texts, opts);
    ctx.postMessage({ id, type: "result", vectors: validVectors(out.tolist(), texts.length) });
    return;
  } catch (e) {
    if (backend !== "webgpu" && !rebuilding) throw e;
  }
  // WebGPU device lost after a successful warm-up (the load-time probe can't
  // catch that): rebuild on wasm and retry this batch once.
  webgpuBroken = true;
  if (!rebuilding) {
    const gen = generation;
    const model = active;
    const dead = extractor;
    extractor = null;
    loading = null; // stale: referred to the dead session; a future load must rebuild
    rebuilding = (async () => {
      try {
        await dead.dispose?.();
      } catch {
        // Best-effort: a lost WebGPU device may reject cleanup even though its
        // resources are already gone.
      }
      if (gen !== generation) throw new Error("disposed during load");
      const candidate = await makeExtractor("wasm", id, model);
      try {
        if (gen !== generation) {
          // "dispose" arrived during the rebuild: don't resurrect the pipeline.
          throw new Error("disposed during load");
        }
        extractor = candidate;
        backend = "wasm";
      } catch (error) {
        void candidate.dispose?.()?.catch(() => {});
        throw error;
      }
    })()
      .finally(() => {
        rebuilding = null;
      });
  }
  await rebuilding;
  if (!extractor || !active) throw new Error("model not loaded");
  const out = await extractor(texts, opts);
  ctx.postMessage({ id, type: "result", vectors: validVectors(out.tolist(), texts.length) });
}

function validVectors(vectors: number[][], count: number): number[][] {
  if (!active || vectors.length !== count || vectors.some((v) => v.length !== active?.dim || !v.every(Number.isFinite))) {
    throw new Error("Embedding output does not match the selected model's dimensions");
  }
  return vectors;
}

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "device-download" || msg.type === "device-generate") {
    void handleDeviceRequest(msg, (response) => ctx.postMessage(response), (allowed) => { allowNetwork = allowed; }, guardedFetch).catch((error: unknown) => {
      allowNetwork = false;
      ctx.postMessage({ type: "device-error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  const fail = (err: unknown) =>
    ctx.postMessage({
      id: msg.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  if (msg.type === "load") {
    if (msg.allowDownload === true) allowNetwork = true;
    void load(msg.id, { repo: msg.repo, pooling: msg.pooling, revision: msg.revision, dtype: msg.dtype, maxTokens: msg.maxTokens, dim: msg.dim }).catch(fail);
  }
  else if (msg.type === "embed") void embed(msg.id, msg.texts).catch(fail);
  else if (msg.type === "dispose") {
    generation++; // cancels any in-flight load (see doLoad)
    void extractor?.dispose?.()?.catch(() => {});
    extractor = null;
    loading = null;
    active = null;
  }
};
