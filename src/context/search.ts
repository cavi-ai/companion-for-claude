// Pure (Obsidian-free) text helpers for vault context + lightweight search.

export function section(title: string, body: string): string {
  return `### ${title}\n${body}`;
}

export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…[truncated]";
}

/** Split a query into deduped, lowercased terms of length >= 3 (max 12). */
export function tokenize(q: string): string[] {
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    ),
  ).slice(0, 12);
}

export function snippetAround(content: string, idx: number): string {
  if (idx < 0) return content.slice(0, 600);
  const start = Math.max(0, idx - 200);
  const end = Math.min(content.length, idx + 600);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

export interface ScoreResult {
  score: number;
  /** Index of the earliest content match, or -1. */
  firstIdx: number;
}

/**
 * Keyword scoring for a single file. Path and tag matches weigh more than body
 * matches. Pure so it can be tested without the vault.
 */
export function scoreContent(terms: string[], lowerPath: string, lowerTags: string, content: string): ScoreResult {
  let score = 0;
  for (const t of terms) if (lowerPath.includes(t)) score += 3;
  for (const t of terms) if (lowerTags.includes(t)) score += 2;

  const lower = content.toLowerCase();
  let firstIdx = -1;
  for (const t of terms) {
    let idx = lower.indexOf(t);
    while (idx !== -1) {
      score += 1;
      if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
      idx = lower.indexOf(t, idx + t.length);
    }
  }
  return { score, firstIdx };
}
