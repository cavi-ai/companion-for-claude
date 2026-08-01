// Link suggestions for the active note (spec 2026-07-05 link intelligence):
// merge unlinked mentions with semantic neighbors into one ranked list, and
// turn accepted mentions into diff-reviewable edits. Pure.

import type { Mention } from "./unlinkedMentions";
import { linkMention } from "./unlinkedMentions";
import type { ProposedEdit } from "../edit/diff";

export interface LinkSuggestion {
  path: string;
  /** Display name (target basename). */
  name: string;
  reasons: Array<"mention" | "related">;
  /** Semantic similarity when known (0..1). */
  score?: number;
  /** Present for mention-backed suggestions (enables one-click linking). */
  mention?: Mention;
}

/**
 * Merge mentions and semantic neighbors, excluding notes the active note
 * already links to. Order: mention-backed suggestions first (document order —
 * they're actionable in place), then related-only by similarity.
 */
export function buildSuggestions(
  mentions: Mention[],
  related: Array<{ path: string; score: number }>,
  alreadyLinked: Set<string>,
): LinkSuggestion[] {
  const byPath = new Map<string, LinkSuggestion>();
  for (const m of mentions) {
    if (alreadyLinked.has(m.path)) continue;
    byPath.set(m.path, { path: m.path, name: m.name, reasons: ["mention"], mention: m });
  }
  for (const r of related) {
    if (alreadyLinked.has(r.path)) continue;
    const existing = byPath.get(r.path);
    if (existing) {
      existing.reasons.push("related");
      existing.score = r.score;
    } else {
      byPath.set(r.path, { path: r.path, name: basename(r.path), reasons: ["related"], score: r.score });
    }
  }
  const all = [...byPath.values()];
  const mentionBacked = all.filter((s) => s.mention).sort((a, b) => a.mention!.start - b.mention!.start);
  const relatedOnly = all.filter((s) => !s.mention).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return [...mentionBacked, ...relatedOnly];
}

/**
 * Build diff-reviewable edits for a set of mentions: every mention is applied
 * to one linked copy of the note, then each covered line becomes an edit whose
 * old_str is grown line-by-line until unique in `content` (planEdits requires
 * exact-once matches). Line ranges that end up covering the same line are
 * merged, so several mentions on one line — or a grown block that swallows a
 * later mention's line — stay a single non-overlapping edit. Mentions that
 * cannot be uniquified are skipped.
 */
export function mentionEdits(content: string, mentions: Mention[]): ProposedEdit[] {
  const applicable = nonOverlapping(mentions);
  if (applicable.length === 0) return [];

  // Rewrite end→start so each mention's recorded offsets are still valid when
  // its turn comes; link text never adds a newline, so line numbers hold.
  let linked = content;
  for (let i = applicable.length - 1; i >= 0; i--) linked = linkMention(linked, applicable[i]!);

  const lines = content.split("\n");
  const linkedLines = linked.split("\n");
  const ranges: Array<{ from: number; to: number }> = [];
  for (const to of [...new Set(applicable.map((m) => m.line - 1))].sort((a, b) => a - b)) {
    const from = uniqueBlockStart(content, lines, to);
    if (from !== null) ranges.push({ from, to });
  }

  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    // A merged block contains an already-unique block, so it stays unique.
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }

  return merged.map(({ from, to }) => ({
    old_str: lines.slice(from, to + 1).join("\n"),
    new_str: linkedLines.slice(from, to + 1).join("\n"),
  }));
}

/** Drop mentions whose span overlaps an earlier one; rewriting both would corrupt the text. */
function nonOverlapping(mentions: Mention[]): Mention[] {
  const kept: Mention[] = [];
  let guard = -1;
  for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
    if (m.start < guard) continue;
    kept.push(m);
    guard = m.end;
  }
  return kept;
}

/** First line of the smallest block ending at `to` that occurs exactly once; null when none does. */
function uniqueBlockStart(content: string, lines: string[], to: number): number | null {
  for (let from = to; from >= 0; from--) {
    if (countOccurrences(content, lines.slice(from, to + 1).join("\n")) === 1) return from;
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return n;
}

function basename(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/, "");
}
