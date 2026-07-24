// Unlinked-mention detection (spec 2026-07-05 link intelligence): find plain-
// text occurrences of other notes' titles/aliases in a note so they can be
// turned into [[wikilinks]]. Pure — candidates and content are injected.

export interface LinkCandidate {
  path: string;
  basename: string;
  aliases: string[];
}

export interface Mention {
  /** Target note. */
  path: string;
  /** The candidate name that matched (basename or alias). */
  name: string;
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
  const mentions: Mention[] = [];

  for (const c of candidates) {
    if (c.path === selfPath) continue;
    const names = [
      { name: c.basename, viaAlias: false },
      ...c.aliases.map((a) => ({ name: a, viaAlias: true })),
    ];
    let best: Mention | null = null;
    for (const { name, viaAlias } of names) {
      if (name.trim().length < MIN_NAME_LENGTH) continue;
      const idx = findWholeWord(masked, name);
      if (idx === -1) continue;
      if (best === null || idx < best.start) {
        const surface = content.slice(idx, idx + name.length);
        best = {
          path: c.path,
          name: c.basename,
          viaAlias,
          surface,
          start: idx,
          end: idx + name.length,
          line: content.slice(0, idx).split("\n").length,
          excerpt: excerptAround(content, idx, idx + name.length),
        };
      }
    }
    if (best) mentions.push(best);
  }

  mentions.sort((a, b) => a.start - b.start);
  return mentions.slice(0, MAX_MENTIONS);
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
    const first = findWholeWord(masked, m.surface);
    if (first === -1) throw new Error("The note changed — the mention no longer applies.");
    start = first;
  }
  const link = !m.viaAlias && m.surface === m.name ? `[[${m.name}]]` : `[[${m.name}|${m.surface}]]`;
  return content.slice(0, start) + link + content.slice(start + m.surface.length);
}

// ---- internals ----

/** A boundary is anything that isn't a letter, digit, or underscore. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/** First case-insensitive whole-word occurrence of `name` in `text` (masked). */
function findWholeWord(text: string, name: string): number {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
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
  out = out.replace(/^---\n[\s\S]*?\n---(\n|$)/, blank);
  // Fenced code blocks.
  out = out.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, blank);
  // Inline code.
  out = out.replace(/`[^`\n]*`/g, blank);
  // Wikilinks (with or without pipe) and embeds.
  out = out.replace(/!?\[\[[^\]]*\]\]/g, blank);
  // Markdown links: mask the whole [text](target).
  out = out.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, blank);
  return out;
}

function excerptAround(content: string, start: number, end: number): string {
  const from = Math.max(0, content.lastIndexOf("\n", start) + 1);
  const toNl = content.indexOf("\n", end);
  const to = toNl === -1 ? content.length : toNl;
  const line = content.slice(from, to).trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
