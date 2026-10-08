// Unlinked-mention detection (spec 2026-07-05 link intelligence): find plain-
// text occurrences of other notes' titles/aliases in a note so they can be
// turned into [[wikilinks]]. Pure — candidates and content are injected.

import { fencedLines } from "../markdown/fences";
import { frontmatterBlock } from "../markdown/frontmatter";
import { lowerSameLength } from "../text";

export interface LinkCandidate {
  path: string;
  basename: string;
  aliases: string[];
  /** What to write as the [[link]] target — the full path (sans .md) when the basename is ambiguous, else the basename. */
  linktext?: string;
}

export interface Mention {
  /** Target note. */
  path: string;
  /** The candidate name that matched (basename or alias). */
  name: string;
  /** What linkMention writes as the [[link]] target (candidate.linktext ?? basename). */
  target: string;
  /** Whether the match was an alias (always linked in pipe form). */
  viaAlias: boolean;
  /** The exact text as it appears in the note. */
  surface: string;
  start: number;
  end: number;
  /** 1-based line of the mention. */
  line: number;
  /** Short surrounding text for display. */
  excerpt: string;
}

const MIN_NAME_LENGTH = 3;
const MAX_MENTIONS = 20;

/**
 * Find the first unlinked plain-text occurrence of each candidate's basename
 * or alias in `content`. Skips frontmatter, code fences, inline code, existing
 * wiki/markdown links, and the note itself. Case-insensitive, word-bounded.
 */
export function findUnlinkedMentions(content: string, candidates: LinkCandidate[], selfPath: string): Mention[] {
  const masked = maskNonProse(content);
  const lowerMasked = lowerSameLength(masked);
  const byPrefix = namesByPrefix(candidates, selfPath);

  // One pass over word starts. The first hit per candidate is its earliest; at
  // one position, bucket order (candidate, then basename before aliases) breaks
  // ties. Hits arrive in position order, so the scan stops once it holds
  // MAX_MENTIONS candidates: every later hit would sort after them.
  const found = new Map<number, { start: number; name: NameEntry }>();
  for (let i = 0; i + MIN_NAME_LENGTH <= lowerMasked.length && found.size < MAX_MENTIONS; i++) {
    const bucket = byPrefix.get(lowerMasked.slice(i, i + MIN_NAME_LENGTH));
    if (!bucket || isWordChar(masked[i - 1])) continue;
    for (const entry of bucket) {
      if (found.has(entry.candidate) || !lowerMasked.startsWith(entry.needle, i) || isWordChar(masked[i + entry.needle.length])) continue;
      found.set(entry.candidate, { start: i, name: entry });
    }
  }

  return [...found]
    .sort(([a, x], [b, y]) => x.start - y.start || a - b)
    .slice(0, MAX_MENTIONS)
    .map(([index, { start, name }]) => {
      const c = candidates[index]!;
      return {
        path: c.path,
        name: c.basename,
        target: c.linktext ?? c.basename,
        viaAlias: name.viaAlias,
        surface: content.slice(start, start + name.length),
        start,
        end: start + name.length,
        line: content.slice(0, start).split("\n").length,
        excerpt: excerptAround(content, start, start + name.length),
      };
    });
}

/**
 * Rewrite one mention in place as a wikilink: `[[Name]]` when the surface text
 * equals the basename exactly, else `[[Name|surface]]`. Re-validates position
 * (unique re-locate on drift) so a stale mention can never corrupt the note.
 */
export function linkMention(content: string, m: Mention): string {
  let start = m.start;
  if (content.slice(start, m.end) !== m.surface) {
    const masked = maskNonProse(content);
    const first = findWholeWord(masked, lowerSameLength(masked), m.surface);
    if (first === -1) throw new Error("The note changed — the mention no longer applies.");
    start = first;
  }
  const link = !m.viaAlias && m.surface === m.target ? `[[${m.target}]]` : `[[${m.target}|${m.surface}]]`;
  return content.slice(0, start) + link + content.slice(start + m.surface.length);
}

/** Link target per candidate: its path when the basename is shared (case-insensitive), else the basename. */
export function withLinktext(candidates: LinkCandidate[]): LinkCandidate[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = c.basename.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.map((c) => {
    const ambiguous = (counts.get(c.basename.toLowerCase()) ?? 0) > 1;
    return { ...c, linktext: ambiguous ? c.path.replace(/\.md$/, "") : c.basename };
  });
}

// ---- internals ----

interface NameEntry {
  candidate: number;
  needle: string;
  /** Length of the name as written; the surface spans this many characters. */
  length: number;
  viaAlias: boolean;
}

/** Every linkable name, lowercased, grouped by its first MIN_NAME_LENGTH characters. */
function namesByPrefix(candidates: LinkCandidate[], selfPath: string): Map<string, NameEntry[]> {
  const byPrefix = new Map<string, NameEntry[]>();
  candidates.forEach((c, candidate) => {
    if (c.path === selfPath) return;
    const names = [{ name: c.basename, viaAlias: false }, ...c.aliases.map((name) => ({ name, viaAlias: true }))];
    for (const { name, viaAlias } of names) {
      if (name.trim().length < MIN_NAME_LENGTH) continue;
      const needle = lowerSameLength(name);
      const prefix = needle.slice(0, MIN_NAME_LENGTH);
      const entry = { candidate, needle, length: name.length, viaAlias };
      const bucket = byPrefix.get(prefix);
      if (bucket) bucket.push(entry);
      else byPrefix.set(prefix, [entry]);
    }
  });
  return byPrefix;
}

/** A boundary is anything that isn't a letter, digit, or underscore. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/** First case-insensitive whole-word occurrence of `name` in `text` (masked). */
function findWholeWord(text: string, lower: string, name: string): number {
  const needle = lowerSameLength(name);
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) return -1;
    const beforeOk = !isWordChar(text[idx - 1]);
    const afterOk = !isWordChar(text[idx + needle.length]);
    if (beforeOk && afterOk) return idx;
    from = idx + 1;
  }
}

/**
 * Replace non-prose spans (frontmatter, code fences, inline code, wiki and
 * markdown links) with same-length null padding so offsets keep lining up
 * while matches inside those spans become impossible.
 */
function maskNonProse(content: string): string {
  let out = content;
  // Keep newlines so line-anchored patterns (and reported offsets) stay true.
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");

  // Frontmatter block at the very start.
  const frontmatter = frontmatterBlock(out);
  if (frontmatter) out = blank(out.slice(0, frontmatter.end)) + out.slice(frontmatter.end);
  // Fenced code blocks, including those inside list items and callouts.
  const lines = out.split("\n");
  const fenced = fencedLines(lines);
  out = lines.map((line, i) => (fenced[i] ? blank(line) : line)).join("\n");
  // Inline code.
  out = out.replace(/`[^`\n]*`/g, blank);
  // Wikilinks (with or without pipe) and embeds.
  out = out.replace(/!?\[\[[^\]]*\]\]/g, blank);
  // Markdown links: mask the whole [text](target).
  out = out.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, blank);
  // Autolinks and bare URLs — a note title can appear inside a path segment.
  out = out.replace(/<https?:\/\/[^>\s]+>/g, blank);
  out = out.replace(/\bhttps?:\/\/[^\s<>()]+/g, blank);
  // Obsidian tags (#tag, #nested/tag) — never prose, so never link-worthy.
  out = out.replace(/(^|\s)#[\p{L}\p{N}_/-]+/gmu, (m, lead: string) => lead + blank(m.slice(lead.length)));
  return out;
}

function excerptAround(content: string, start: number, end: number): string {
  const from = Math.max(0, content.lastIndexOf("\n", start) + 1);
  const toNl = content.indexOf("\n", end);
  const to = toNl === -1 ? content.length : toNl;
  const line = content.slice(from, to).trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
