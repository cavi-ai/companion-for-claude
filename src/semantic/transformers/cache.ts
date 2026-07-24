// Cache-awareness for the consent gate: has the built-in model already been
// downloaded, and how to delete it again. transformers.js stores browser
// downloads in the Cache API bucket `env.cacheKey` ("transformers-cache" —
// verified against @huggingface/transformers@4.2.0 src/env.js +
// src/utils/cache.js), keyed by the remote URL
// (https://huggingface.co/<repo>/resolve/<rev>/<file>; ORT runtime assets are
// cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/ort-*, per
// src/backends/onnx.js). The CacheStorage is injected so this stays pure and
// unit-testable.

import { BUILTIN_EMBEDDING_MODEL } from "./model";

/** transformers.js's default Cache API bucket (env.cacheKey). */
export const TRANSFORMERS_CACHE_NAME = "transformers-cache";

/** The slice of CacheStorage this module needs (window.caches satisfies it). */
export interface CachesLike {
  open(name: string): Promise<{
    keys(): Promise<ReadonlyArray<{ url: string }>>;
    delete(url: string): Promise<boolean>;
  }>;
}

/** Entries the built-in engine put in the bucket: our repo's files, or the
 *  ORT runtime assets that env.useWasmCache stores alongside them. */
function isBuiltinEngineEntry(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isBuiltinRepoFile = parsed.pathname.includes(`/${BUILTIN_EMBEDDING_MODEL.hfRepo}/`);
    const isOrtRuntimeAsset =
      parsed.hostname === "cdn.jsdelivr.net" &&
      parsed.pathname.includes("/npm/onnxruntime-web@") &&
      parsed.pathname.includes("/dist/ort-");
    return isBuiltinRepoFile || isOrtRuntimeAsset;
  } catch {
    return false;
  }
}

/**
 * Whether the built-in model's weights are already in the local cache — i.e.
 * embedding can proceed fully offline, no new download. Requires the .onnx
 * weights entry specifically (a stray config.json from an aborted download
 * must not pass the consent gate). False when the Cache API is unavailable
 * or unreadable.
 */
export async function hasCachedModel(cachesLike: CachesLike | undefined): Promise<boolean> {
  if (!cachesLike) return false;
  try {
    const cache = await cachesLike.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    return keys.some((k) => {
      try {
        const parsed = new URL(k.url);
        return parsed.pathname.includes(`/${BUILTIN_EMBEDDING_MODEL.hfRepo}/`) && parsed.pathname.endsWith(".onnx");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Delete the built-in model's downloaded files (weights, tokenizer, config)
 * plus the ORT runtime assets from the local cache. Other models' entries are
 * untouched. Returns the number of entries deleted (0 when the Cache API is
 * unavailable or unreadable).
 */
export async function clearCachedModel(cachesLike: CachesLike | undefined): Promise<number> {
  if (!cachesLike) return 0;
  try {
    const cache = await cachesLike.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    let deleted = 0;
    for (const k of keys) {
      if (isBuiltinEngineEntry(k.url) && (await cache.delete(k.url))) deleted++;
    }
    return deleted;
  } catch {
    return 0;
  }
}
