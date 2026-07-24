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
 * Build diff-reviewable edits for a set of mentions: each edit's old_str is
 * grown line-by-line until unique in `content` (planEdits requires exact-once
 * matches). Mentions that cannot be uniquified are skipped.
 */
export function mentionEdits(content: string, mentions: Mention[]): ProposedEdit[] {
  const lines = content.split("\n");
  const edits: ProposedEdit[] = [];
  for (const m of mentions) {
    const linked = linkMention(content, m);
    // The changed region is exactly one line; grow context upward until unique.
    const lineIdx = m.line - 1;
    for (let up = 0; lineIdx - up >= 0; up++) {
      const oldBlock = lines.slice(lineIdx - up, lineIdx + 1).join("\n");
      if (countOccurrences(content, oldBlock) === 1) {
        const newBlock = linked.split("\n").slice(lineIdx - up, lineIdx + 1).join("\n");
        edits.push({ old_str: oldBlock, new_str: newBlock });
        break;
      }
      if (lineIdx - up === 0) break; // reached file start without uniqueness — skip
    }
  }
  return edits;
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
