// The embedding-engine seam (spec 2026-07-09). The indexer takes an injected
// embed fn and keys invalidation on a model string; Embedder pairs the two so
// main.ts can route by settings.embeddingEngine. Pure.

import { BUILTIN_EMBEDDING_MODEL } from "./transformers/model";

export type EmbeddingEngine = "builtin" | "ollama";

export interface Embedder {
  /** Index key. Ollama: the raw model name (legacy-compatible). Builtin: "builtin:<model>". */
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** The store/index key for the active engine. */
export function embedderId(engine: EmbeddingEngine, ollamaModel: string): string {
  return engine === "builtin" ? BUILTIN_EMBEDDING_MODEL.id : ollamaModel;
}

/**
 * Settings migration for the engine key: a user whose persisted settings have
 * semantic search enabled but no `embeddingEngine` predates the engine choice —
 * they are definitionally a working Ollama user, so keep them on Ollama instead
 * of silently repointing their index at the builtin engine. Returns the engine
 * to force, or undefined to let stored/default values apply.
 */
export function migrateEmbeddingEngine(
  persisted: Partial<{ embeddingEngine: EmbeddingEngine; semanticEnabled: boolean }> | null | undefined,
): EmbeddingEngine | undefined {
  if (!persisted || "embeddingEngine" in persisted) return undefined;
  return persisted.semanticEnabled === true ? "ollama" : undefined;
}

export class OllamaEmbedder implements Embedder {
  constructor(
    private model: string,
    private embedFn: (model: string, input: string[]) => Promise<number[][]>,
  ) {}

  get id(): string {
    return this.model;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.embedFn(this.model, texts);
  }
}
