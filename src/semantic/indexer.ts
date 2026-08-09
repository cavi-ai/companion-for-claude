// Orchestrates the semantic index: traverse → chunk → embed → store → persist.
// IO is injected (vault read, embed, load/save) so the logic is unit-testable
// without Obsidian or a running Ollama. main.ts wires the real implementations.

import { chunkNote, contentHash, stripFrontmatter, type Chunk } from "./chunk";
import { chunkPdfPages, pdfPagesText, type PdfPage } from "./pdf";
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
  /** PDF files to index; absent → markdown-only index. */
  listPdf?(): IndexFile[];
  /** Extract a PDF's per-page text; null → skipped this build (unreadable/encrypted). */
  readPdfPages?(path: string): Promise<PdfPage[] | null>;
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
  failureCount: number;
  failures: Array<{ path: string; message: string }>;
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
    const files = [...this.deps.listMarkdown(), ...(this.deps.listPdf?.() ?? [])];
    const live = new Set(files.map((f) => f.path));
    let indexed = 0;
    let skipped = 0;
    let failureCount = 0;
    const failures: Array<{ path: string; message: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f) continue;
      try {
        const prepared = await this.prepare(f.path);
        if (!prepared) {
          skipped++;
        } else if (!opts.force && !store.needsReindex(f.path, prepared.hash)) {
          skipped++;
        } else {
          await this.embedInto(store, f.path, f.mtime, prepared.chunks, prepared.hash);
          indexed++;
        }
      } catch (error) {
        // Unreadable / embed failure for one file shouldn't abort the whole build.
        skipped++;
        failureCount++;
        if (failures.length < 20) {
          failures.push({
            path: f.path,
            message: (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500),
          });
        }
      }
      opts.onProgress?.(i + 1, files.length);
    }

    const removed = store.pruneTo(live);
    await this.deps.save(store.toJSON());
    return { indexed, skipped, removed, failureCount, failures };
  }

  /** Re-embed a single note (on modify). No-op if semantic store can't load. */
  async updateNote(path: string, mtime: number): Promise<void> {
    const store = await this.ensureLoaded();
    const prepared = await this.prepare(path);
    if (!prepared) return;
    if (!store.needsReindex(path, prepared.hash)) return;
    await this.embedInto(store, path, mtime, prepared.chunks, prepared.hash);
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

  /** Chunks + change hash for one file: markdown notes directly, PDFs via page extraction. */
  private async prepare(path: string): Promise<{ hash: string; chunks: Chunk[] } | null> {
    if (path.toLowerCase().endsWith(".pdf")) {
      if (!this.deps.readPdfPages) return null;
      const pages = await this.deps.readPdfPages(path);
      if (!pages || pages.length === 0) return null;
      return { hash: contentHash(pdfPagesText(pages)), chunks: chunkPdfPages(pages) };
    }
    const text = await this.deps.read(path);
    return { hash: contentHash(stripFrontmatter(text)), chunks: chunkNote(text) };
  }

  private async embedInto(store: SemanticStore, path: string, mtime: number, chunks: Chunk[], hash: string): Promise<void> {
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
