// Orchestrates the semantic index: traverse → chunk → embed → store → persist.
// IO is injected (vault read, embed, load/save) so the logic is unit-testable
// without Obsidian or a running Ollama. main.ts wires the real implementations.

import { chunkNote, contentHash, stripFrontmatter } from "./chunk";
import { SemanticStore, type IndexData, type SearchHit } from "./store";

export interface IndexFile {
  path: string;
  mtime: number;
}

export interface IndexerDeps {
  /** Embedding model id — also the store's invalidation key. */
  embeddingModel: string;
  /** Markdown files in the vault (path + mtime). */
  listMarkdown(): IndexFile[];
  /** Read a note's full text. */
  read(path: string): Promise<string>;
  /** Embed texts with the configured model; one vector per input, in order. */
  embed(input: string[]): Promise<number[][]>;
  /** Load the persisted index blob (or null/undefined if none). */
  load(): Promise<unknown>;
  /** Persist the index blob. */
  save(data: IndexData): Promise<void>;
}

export interface BuildResult {
  indexed: number;
  skipped: number;
  removed: number;
}

export class SemanticIndexer {
  private store: SemanticStore | null = null;

  constructor(private deps: IndexerDeps) {}

  /** Drop the in-memory store (e.g. after the embedding model changes). */
  invalidate(): void {
    this.store = null;
  }

  private async ensureLoaded(): Promise<SemanticStore> {
    if (!this.store) this.store = SemanticStore.load(await this.deps.load(), this.deps.embeddingModel);
    return this.store;
  }

  async stats(): Promise<{ notes: number; chunks: number }> {
    return (await this.ensureLoaded()).stats();
  }

  /**
   * Build or refresh the whole index. Skips notes whose content hash is
   * unchanged unless `force`. Prunes notes that left the vault, then persists.
   */
  async build(opts: { force?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<BuildResult> {
    const store = await this.ensureLoaded();
    const files = this.deps.listMarkdown();
    const live = new Set(files.map((f) => f.path));
    let indexed = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f) continue;
      try {
        const text = await this.deps.read(f.path);
        const hash = contentHash(stripFrontmatter(text));
        if (!opts.force && !store.needsReindex(f.path, hash)) {
          skipped++;
        } else {
          await this.embedInto(store, f.path, f.mtime, text, hash);
          indexed++;
        }
      } catch {
        // Unreadable / embed failure for one note shouldn't abort the whole build.
        skipped++;
      }
      opts.onProgress?.(i + 1, files.length);
    }

    const removed = store.pruneTo(live);
    await this.deps.save(store.toJSON());
    return { indexed, skipped, removed };
  }

  /** Re-embed a single note (on modify). No-op if semantic store can't load. */
  async updateNote(path: string, mtime: number): Promise<void> {
    const store = await this.ensureLoaded();
    const text = await this.deps.read(path);
    const hash = contentHash(stripFrontmatter(text));
    if (!store.needsReindex(path, hash)) return;
    await this.embedInto(store, path, mtime, text, hash);
    await this.deps.save(store.toJSON());
  }

  async removeNote(path: string): Promise<void> {
    const store = await this.ensureLoaded();
    if (!store.hasNote(path)) return;
    store.removeNote(path);
    await this.deps.save(store.toJSON());
  }

  async renameNote(oldPath: string, newPath: string): Promise<void> {
    const store = await this.ensureLoaded();
    if (!store.hasNote(oldPath)) return;
    store.renameNote(oldPath, newPath);
    await this.deps.save(store.toJSON());
  }

  /** Semantic search: embed the query, return best chunk per note (top k). */
  async search(query: string, k: number): Promise<SearchHit[]> {
    const store = await this.ensureLoaded();
    if (store.stats().chunks === 0) return [];
    const [qv] = await this.deps.embed([query]);
    if (!qv || qv.length === 0) return [];
    return store.search(qv, k);
  }

  /**
   * Notes semantically related to `path`. Uses the note's stored centroid (fast,
   * offline). If the note isn't indexed yet, live-embeds its first chunk as a
   * fallback so the panel still shows something.
   */
  async related(path: string, k: number): Promise<SearchHit[]> {
    const store = await this.ensureLoaded();
    if (store.stats().chunks === 0) return [];
    const stored = store.related(path, k);
    if (stored.length || store.hasNote(path)) return stored;

    const chunks = chunkNote(await this.deps.read(path));
    const first = chunks[0];
    if (!first) return [];
    const [v] = await this.deps.embed([first.text]);
    if (!v || v.length === 0) return [];
    return store
      .search(v, k + 1)
      .filter((h) => h.path !== path)
      .slice(0, k);
  }

  private async embedInto(store: SemanticStore, path: string, mtime: number, text: string, hash: string): Promise<void> {
    const chunks = chunkNote(text);
    if (chunks.length === 0) {
      store.removeNote(path); // empty / frontmatter-only note carries nothing
      return;
    }
    const vectors = await this.deps.embed(chunks.map((c) => c.text));
    store.upsertNote(
      path,
      hash,
      mtime,
      chunks.map((c, j) => ({ ord: c.ord, text: c.text, vector: vectors[j] ?? [] })),
    );
  }
}
