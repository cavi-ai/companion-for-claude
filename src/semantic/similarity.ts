// Pure vector math + hybrid fusion for semantic retrieval. No Obsidian, no IO.

/** Cosine similarity in [-1, 1]; 0 if either vector is empty/zero. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Ranked {
  id: string;
  score: number;
}

/** Top-k items by cosine against a query vector (descending). */
export function topKByVector(
  query: number[],
  items: { id: string; vector: number[] }[],
  k: number,
): Ranked[] {
  const scored = items.map((it) => ({ id: it.id, score: cosineSimilarity(query, it.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}

/**
 * Reciprocal-rank fusion of several ranked lists into one. Rank position (not
 * raw score) drives the blend, so a keyword list and a cosine list combine
 * without needing comparable score scales. `k` tempers how much top ranks
 * dominate (60 is the common default).
 */
export function reciprocalRankFusion(lists: Ranked[][], k = 60): Ranked[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    list.forEach((r, i) => {
      acc.set(r.id, (acc.get(r.id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return Array.from(acc, ([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
