// Pure in-memory vector store + (de)serialization. No Obsidian, no IO — the
// indexer service feeds it embeddings and persists toJSON()/fromJSON().

import { topKByVector } from "./similarity";

export const INDEX_VERSION = 1;

export interface ChunkRecord {
  ord: number;
  text: string;
  vector: number[];
}

export interface NoteEntry {
  /** contentHash() of the note body at index time — change detection. */
  hash: string;
  mtime: number;
  chunks: ChunkRecord[];
}

export interface IndexData {
  version: number;
  /** Embedding model used to build the index; a change invalidates it. */
  model: string;
  /** Vector dimension (0 until first note indexed). */
  dim: number;
  notes: Record<string, NoteEntry>;
}

export interface SearchHit {
  path: string;
  ord: number;
  text: string;
  score: number;
}

export function emptyIndex(model: string): IndexData {
  return { version: INDEX_VERSION, model, dim: 0, notes: {} };
}

/**
 * A thin, pure wrapper over IndexData with the operations the indexer needs.
 * Stores best-effort: callers persist via toJSON() after mutating.
 */
export class SemanticStore {
  constructor(private data: IndexData) {}

  /** Rebuild from persisted JSON, or start empty if absent/stale/model-changed. */
  static load(raw: unknown, model: string): SemanticStore {
    const d = raw as Partial<IndexData> | null | undefined;
    if (!d || d.version !== INDEX_VERSION || d.model !== model || typeof d.notes !== "object") {
      return new SemanticStore(emptyIndex(model));
    }
    return new SemanticStore({
      version: INDEX_VERSION,
      model,
      dim: d.dim ?? 0,
      notes: d.notes,
    });
  }

  get model(): string {
    return this.data.model;
  }

  toJSON(): IndexData {
    return this.data;
  }

  /** True if this path is absent or its content hash differs from what's indexed. */
  needsReindex(path: string, hash: string): boolean {
    const e = this.data.notes[path];
    return !e || e.hash !== hash;
  }

  hasNote(path: string): boolean {
    return path in this.data.notes;
  }

  upsertNote(path: string, hash: string, mtime: number, chunks: ChunkRecord[]): void {
    this.data.notes[path] = { hash, mtime, chunks };
    const first = chunks[0];
    if (first?.vector.length) this.data.dim = first.vector.length;
  }

  removeNote(path: string): void {
    delete this.data.notes[path];
  }

  renameNote(oldPath: string, newPath: string): void {
    const e = this.data.notes[oldPath];
    if (!e) return;
    this.data.notes[newPath] = e;
    delete this.data.notes[oldPath];
  }

  /** Drop indexed notes whose paths are no longer present in the vault. */
  pruneTo(livePaths: Set<string>): number {
    let removed = 0;
    for (const p of Object.keys(this.data.notes)) {
      if (!livePaths.has(p)) {
        delete this.data.notes[p];
        removed++;
      }
    }
    return removed;
  }

  stats(): { notes: number; chunks: number } {
    let chunks = 0;
    for (const e of Object.values(this.data.notes)) chunks += e.chunks.length;
    return { notes: Object.keys(this.data.notes).length, chunks };
  }

  /**
   * Cosine search over all chunks. Returns the best chunk per note (so results
   * are note-deduped for citation), highest score first, up to k notes.
   */
  search(queryVec: number[], k: number): SearchHit[] {
    const items: { id: string; vector: number[] }[] = [];
    const meta = new Map<string, { path: string; ord: number; text: string }>();
    for (const [path, entry] of Object.entries(this.data.notes)) {
      for (const c of entry.chunks) {
        const id = `${path}\t${c.ord}`;
        items.push({ id, vector: c.vector });
        meta.set(id, { path, ord: c.ord, text: c.text });
      }
    }
    if (!items.length) return [];

    // Rank all chunks, then keep the top-scoring chunk per note.
    const ranked = topKByVector(queryVec, items, items.length);
    const bestPerNote = new Map<string, SearchHit>();
    for (const r of ranked) {
      const m = meta.get(r.id);
      if (!m) continue;
      if (!bestPerNote.has(m.path)) {
        bestPerNote.set(m.path, { path: m.path, ord: m.ord, text: m.text, score: r.score });
      }
    }
    return Array.from(bestPerNote.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }

  /** Centroid (mean) of a note's chunk vectors, or null if it isn't indexed. */
  noteVector(path: string): number[] | null {
    const e = this.data.notes[path];
    if (!e || e.chunks.length === 0) return null;
    const first = e.chunks[0];
    if (!first) return null;
    const dim = first.vector.length;
    const sum = new Array<number>(dim).fill(0);
    for (const c of e.chunks) {
      for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (c.vector[i] ?? 0);
    }
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) / e.chunks.length;
    return sum;
  }

  /**
   * Notes most similar to the given note (by chunk-centroid), excluding the note
   * itself. Returns [] if the note isn't indexed.
   */
  related(path: string, k: number): SearchHit[] {
    const v = this.noteVector(path);
    if (!v) return [];
    return this.search(v, k + 1)
      .filter((h) => h.path !== path)
      .slice(0, Math.max(0, k));
  }
}
