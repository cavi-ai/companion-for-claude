// Pure (Obsidian-free) markdown chunking for the semantic index.
//
// Notes are split into heading-aware, size-capped chunks. Frontmatter is dropped
// (we don't embed YAML), and each chunk carries its nearest heading so the
// embedding keeps topical context even when the body is split mid-section.

export interface Chunk {
  /** Position of this chunk within the note (stable ordering). */
  ord: number;
  /** Chunk text, prefixed with its heading for embedding context. */
  text: string;
  /** Nearest heading title, or "" if the chunk sits above any heading. */
  heading: string;
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

/** Strip a leading YAML frontmatter block. */
export function stripFrontmatter(md: string): string {
  return md.replace(FRONTMATTER_RE, "");
}

/**
 * Fast, stable, non-cryptographic hash (FNV-1a 32-bit) for change detection.
 * We only need "did this note's content change since we indexed it" — not
 * collision resistance — so this avoids the async crypto.subtle API.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface ChunkOptions {
  /** Soft cap on characters per chunk. */
  maxChars?: number;
  /** Characters of overlap between size-split pieces of one section. */
  overlap?: number;
}

/**
 * Split markdown into heading-aware, size-capped chunks. Returns [] for an
 * empty/frontmatter-only note.
 */
export function chunkNote(md: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1500;
  const overlap = Math.min(opts.overlap ?? 150, Math.floor(maxChars / 2));
  const body = stripFrontmatter(md).trim();
  if (!body) return [];

  // 1) Split into heading-led sections.
  const sections: { heading: string; text: string }[] = [];
  let curHeading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading: curHeading, text });
    buf = [];
  };
  for (const line of body.split("\n")) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      curHeading = m[2].trim();
    }
    buf.push(line);
  }
  flush();

  // 2) Size-cap each section, carrying the heading into each piece.
  const chunks: Chunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    for (const piece of splitToSize(sec.text, maxChars, overlap)) {
      const prefix = sec.heading && !piece.startsWith("#") ? `${sec.heading}\n\n` : "";
      const text = (prefix + piece).trim();
      if (text) chunks.push({ ord: ord++, text, heading: sec.heading });
    }
  }
  return chunks;
}

/** Greedily split text to <= maxChars, preferring paragraph/sentence boundaries. */
function splitToSize(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const para = slice.lastIndexOf("\n\n");
      const sent = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
      const cut = para > maxChars * 0.5 ? para : sent > maxChars * 0.5 ? sent : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
