// Shared, pure string helpers. No Obsidian, no IO.

/**
 * Lowercase without changing length, so an index into the result is an index
 * into the input. A character whose lowercase is longer (`İ` → `i̇`) keeps its case.
 */
export function lowerSameLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  return text.replace(/[\s\S]/gu, (ch) => {
    const l = ch.toLowerCase();
    return l.length === ch.length ? l : ch;
  });
}

/** Occurrences of `needle` in `haystack`, overlapping ones included; 0 for an empty needle. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) n++;
  return n;
}

/** A vault path's note name: its last segment without a `.md` extension. */
export function noteName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
