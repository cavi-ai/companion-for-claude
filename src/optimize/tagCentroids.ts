import type { Vocabulary } from "../tags/vocabulary";

export function tagCentroids(
  vocab: Vocabulary,
  noteVector: (path: string) => number[] | null,
): (tag: string) => number[] | null {
  const memo = new Map<string, number[] | null>();
  return (tag) => {
    if (memo.has(tag)) return memo.get(tag) ?? null;
    const stat = vocab.get(tag);
    let sum: number[] | null = null;
    let n = 0;
    for (const path of stat?.notes ?? []) {
      const vec = noteVector(path);
      if (!vec || vec.length === 0) continue;
      if (!sum) sum = vec.slice();
      else if (vec.length === sum.length) for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (vec[i] ?? 0);
      else continue;
      n++;
    }
    const centroid = sum && n > 0 ? sum.map((v) => v / n) : null;
    memo.set(tag, centroid);
    return centroid;
  };
}
