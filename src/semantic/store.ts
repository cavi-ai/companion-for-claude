// Pure in-memory vector store + (de)serialization. No Obsidian, no IO — the
// indexer service feeds it embeddings and persists toJSON()/fromJSON().

import { cosineSimilarity } from "./similarity";
import { isRecord } from "../records";

/** Version 2 persists each vector as base64 little-endian float32 (3.9x smaller than JSON numbers). */
export const INDEX_VERSION = 2;
/** Version 1 persisted vectors as JSON number arrays; still read, and rewritten as version 2 on the next save. */
const LEGACY_INDEX_VERSION = 1;
/** An mtime no vault file has: the entry is re-read on the next build. */
export const REREAD_MTIME = -1;

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

/** The on-disk shape: IndexData with each vector encoded by encodeVector. */
export interface PersistedIndex {
  version: number;
  model: string;
  dim: number;
  notes: Record<string, { hash: string; mtime: number; chunks: Array<{ ord: number; text: string; vector: string }> }>;
}

/** A vector as base64 little-endian float32. */
export function encodeVector(vector: readonly number[]): string {
  const view = new DataView(new ArrayBuffer(vector.length * 4));
  vector.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return btoa(String.fromCharCode(...new Uint8Array(view.buffer)));
}

/** The vector encodeVector wrote, or null when it is not `dim` finite float32 values. */
export function decodeVector(encoded: unknown, dim: number): number[] | null {
  if (typeof encoded !== "string" || dim <= 0) return null;
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  if (binary.length !== dim * 4) return null;
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const vector = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) return null;
    vector[i] = value;
  }
  return vector;
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
 * The notes with every vector read back, or null when any entry lacks the fields
 * the store reads (hash, mtime, chunks[] of ord/text/`dim`-long finite vector).
 */
function readNotes(notes: Record<string, unknown>, dim: number, readVector: (vector: unknown) => number[] | null): Record<string, NoteEntry> | null {
  const out: Record<string, NoteEntry> = {};
  for (const [path, entry] of Object.entries(notes)) {
    if (!isRecord(entry) || typeof entry.hash !== "string" || !Number.isFinite(entry.mtime) || !Array.isArray(entry.chunks)) return null;
    const chunks: ChunkRecord[] = [];
    for (const chunk of entry.chunks as unknown[]) {
      if (!isRecord(chunk) || !Number.isInteger(chunk.ord) || (chunk.ord as number) < 0 || typeof chunk.text !== "string") return null;
      const vector = readVector(chunk.vector);
      if (!vector) return null;
      chunks.push({ ord: chunk.ord as number, text: chunk.text, vector });
    }
    out[path] = { hash: entry.hash, mtime: entry.mtime as number, chunks };
  }
  return out;
}

const legacyVector = (dim: number) => (vector: unknown): number[] | null =>
  Array.isArray(vector) && dim > 0 && vector.length === dim && vector.every(Number.isFinite) ? (vector as number[]) : null;

/**
 * A thin, pure wrapper over IndexData with the operations the indexer needs.
 * Stores best-effort: callers persist via toJSON() after mutating.
 */
export class SemanticStore {
  constructor(private data: IndexData) {}

  /** Rebuild from persisted JSON, or start empty if absent/stale/model-changed/corrupt. */
  static load(raw: unknown, model: string): SemanticStore {
    const d = raw as { version?: unknown; model?: unknown; dim?: unknown; notes?: unknown } | null | undefined;
    // `typeof null === "object"`, so a persisted `notes: null` would otherwise
    // pass and crash on the first read. Validate shape, not just typeof.
    if (
      !d ||
      (d.version !== INDEX_VERSION && d.version !== LEGACY_INDEX_VERSION) ||
      d.model !== model ||
      !isRecord(d.notes) ||
      !Number.isInteger(d.dim) || (d.dim as number) < 0
    ) {
      return new SemanticStore(emptyIndex(model));
    }
    const dim = d.dim as number;
    const notes = readNotes(d.notes, dim, d.version === INDEX_VERSION ? (vector) => decodeVector(vector, dim) : legacyVector(dim));
    if (!notes) return new SemanticStore(emptyIndex(model));
    // Version 1 was chunked before fenced headings and empty frontmatter were
    // handled. An mtime no file has makes the next build re-read each note once;
    // only notes whose chunks changed are re-embedded.
    if (d.version === LEGACY_INDEX_VERSION) for (const entry of Object.values(notes)) entry.mtime = REREAD_MTIME;
    return new SemanticStore({ version: INDEX_VERSION, model, dim, notes });
  }

  get model(): string {
    return this.data.model;
  }

  get dim(): number {
    return this.data.dim;
  }

  /** The persisted form; JSON.stringify calls this. */
  toJSON(): PersistedIndex {
    const notes: PersistedIndex["notes"] = {};
    for (const [path, entry] of Object.entries(this.data.notes)) {
      notes[path] = { hash: entry.hash, mtime: entry.mtime, chunks: entry.chunks.map((c) => ({ ord: c.ord, text: c.text, vector: encodeVector(c.vector) })) };
    }
    return { version: INDEX_VERSION, model: this.data.model, dim: this.data.dim, notes };
  }

  /** True if this path is absent, its content hash differs, or (when given) its chunk texts differ from what's indexed. */
  needsReindex(path: string, hash: string, chunkTexts?: readonly string[]): boolean {
    const e = this.data.notes[path];
    if (!e || e.hash !== hash) return true;
    return chunkTexts !== undefined && (chunkTexts.length !== e.chunks.length || chunkTexts.some((text, i) => text !== e.chunks[i]?.text));
  }

  /** Records that the indexed note was re-read at `mtime` and needed no re-embedding. */
  markCurrent(path: string, mtime: number): void {
    const e = this.data.notes[path];
    if (e) e.mtime = mtime;
  }

  /** True if the path is indexed at exactly this mtime. */
  isCurrent(path: string, mtime: number): boolean {
    return this.data.notes[path]?.mtime === mtime;
  }

  hasNote(path: string): boolean {
    return path in this.data.notes;
  }

  chunkCount(path: string): number { return this.data.notes[path]?.chunks.length ?? 0; }

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
   *
   * Single pass: score each chunk and keep the best per note as we go, instead
   * of materializing every chunk + a parallel metadata map and sorting the whole
   * chunk set. Allocation is per-note (the result), not per-chunk.
   */
  search(queryVec: number[], k: number, accept?: (path: string) => boolean): SearchHit[] {
    const bestPerNote = new Map<string, SearchHit>();
    for (const [path, entry] of Object.entries(this.data.notes)) {
      if (accept && !accept(path)) continue;
      let best: SearchHit | undefined;
      for (const c of entry.chunks) {
        const score = cosineSimilarity(queryVec, c.vector);
        if (!best || score > best.score) {
          best = { path, ord: c.ord, text: c.text, score };
        }
      }
      if (best) bestPerNote.set(path, best);
    }
    if (bestPerNote.size === 0) return [];
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
  related(path: string, k: number, accept?: (path: string) => boolean): SearchHit[] {
    const v = this.noteVector(path);
    if (!v) return [];
    return this.search(v, k + 1, accept)
      .filter((h) => h.path !== path)
      .slice(0, Math.max(0, k));
  }
}
