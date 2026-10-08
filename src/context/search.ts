// Pure (Obsidian-free) text helpers for vault context + lightweight search.

import { lowerSameLength } from "../text";

export function section(title: string, body: string): string {
  return `### ${title}\n${body}`;
}

export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n…[truncated]";
}

/** Common English words that name no topic; they never become query terms. */
const STOPWORDS: ReadonlySet<string> = new Set(
  ("the and for are but not you all any can had her was one our out has him his how its may new now old see two way who boy did get let put say she too use " +
    "about above after again also been before being below between both could does doing down during each few from further have having here hers herself " +
    "himself into itself just more most myself nor off once only other ought ours ourselves over own same should some such than that their theirs them " +
    "themselves then there these they this those through under until very were what when where which while whom why will with would your yours yourself " +
    "yourselves want need know think like make made tell show find give note notes thing things something anything").split(" "),
);

/** Split a query into deduped, lowercased content terms of length >= 3, stopwords dropped (max 12). */
export function tokenize(q: string): string[] {
  return Array.from(
    new Set(
      lowerSameLength(q)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ).slice(0, 12);
}

export function snippetAround(content: string, idx: number): string {
  if (idx < 0) return content.slice(0, 600);
  const start = Math.max(0, idx - 200);
  const end = Math.min(content.length, idx + 600);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

/** How one note matches each query term. */
export interface TermStats {
  /** Body occurrences per term. */
  counts: number[];
  /** Per term: whether the path (title) contains it. */
  inPath: boolean[];
  /** Per term: whether a tag contains it. */
  inTags: boolean[];
  /** Body length in characters. */
  length: number;
  /** Index of the earliest body match, or -1. */
  firstIdx: number;
}

/** Match each term against one note's path, tags, and body. */
export function termStats(terms: readonly string[], path: string, tags: string, content: string): TermStats {
  const lowerPath = lowerSameLength(path);
  const lowerTags = lowerSameLength(tags);
  const lower = lowerSameLength(content);
  let firstIdx = -1;
  const counts = terms.map((t) => {
    if (t.length === 0) return 0; // indexOf("") never advances
    let n = 0;
    for (let idx = lower.indexOf(t); idx !== -1; idx = lower.indexOf(t, idx + t.length)) {
      n++;
      if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
    }
    return n;
  });
  return { counts, inPath: terms.map((t) => lowerPath.includes(t)), inTags: terms.map((t) => lowerTags.includes(t)), length: content.length, firstIdx };
}

/** Whether a note matches any term at all. */
export function matchesAny(s: TermStats): boolean {
  return s.counts.some((n) => n > 0) || s.inPath.includes(true) || s.inTags.includes(true);
}

/** What BM25 needs from the whole vault: note count, mean body length, and per-term note frequency. */
export interface CorpusStats {
  docs: number;
  avgLength: number;
  df: number[];
}

const K1 = 1.2;
const B = 0.75;
const PATH_BOOST = 3;
const TAG_BOOST = 2;

/**
 * BM25 over the body, plus fixed boosts for title and tag matches, each scaled
 * by the term's IDF: a term every note has adds little, and long notes do not
 * win on raw repetition.
 */
export function bm25Score(s: TermStats, corpus: CorpusStats): number {
  const avg = corpus.avgLength > 0 ? corpus.avgLength : 1;
  let score = 0;
  s.counts.forEach((tf, i) => {
    const df = corpus.df[i] ?? 0;
    const idf = Math.log(1 + (corpus.docs - df + 0.5) / (df + 0.5));
    if (tf > 0) score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * s.length) / avg));
    if (s.inPath[i]) score += idf * PATH_BOOST;
    if (s.inTags[i]) score += idf * TAG_BOOST;
  });
  return score;
}
