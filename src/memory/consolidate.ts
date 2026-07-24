// Memory consolidation (spec 2026-07-05): merge episodic session digests into
// one evolving "What Claude Knows" note that the agent loop reads back through
// its own vault tools. Pure — file contents and the model call are injected.

import { buildFrontmatter, normalizeTags } from "../indexing/frontmatter";

export const MEMORY_NOTE_BASENAME = "What Claude Knows";

export interface DigestSource {
  path: string;
  mtime: number;
  content: string;
}

const DEFAULT_MAX_DIGESTS = 15;
const DEFAULT_MAX_CHARS = 24_000;

/**
 * Pick the digest notes to consolidate: only real session digests (identified
 * by their `session_id` frontmatter), never the memory note itself, newest
 * first, capped by count and total characters (oldest dropped first).
 */
export function selectDigests(files: DigestSource[], opts?: { max?: number; maxChars?: number }): DigestSource[] {
  const max = opts?.max ?? DEFAULT_MAX_DIGESTS;
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const digests = files
    .filter((f) => !f.path.endsWith(`/${MEMORY_NOTE_BASENAME}.md`) && f.path !== `${MEMORY_NOTE_BASENAME}.md`)
    .filter((f) => /^---\n[\s\S]*?^session_id:/m.test(f.content))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max);

  const out: DigestSource[] = [];
  let used = 0;
  for (const d of digests) {
    if (used + d.content.length > maxChars && out.length > 0) break;
    out.push(d);
    used += d.content.length;
  }
  return out;
}

/**
 * The consolidation instruction: merge new digests into the durable memory
 * note. Format rules keep the output stable and reviewable.
 */
export function buildConsolidationPrompt(existing: string | null, digests: string[]): string {
  const existingBlock = existing
    ? `CURRENT MEMORY NOTE (revise this — keep facts that still hold, drop stale ones):\n\n${existing}`
    : "There is no existing memory note yet — write the first one.";
  const digestBlocks = digests.map((d, i) => `--- Session digest ${i + 1} ---\n${d}`).join("\n\n");
  return `You maintain a single durable memory note about this user's work, distilled from their recent Claude session digests.

${existingBlock}

NEW SESSION DIGESTS:

${digestBlocks}

Rewrite the complete memory note now. Rules:
- Markdown body only — no frontmatter, no title heading, no preamble or commentary.
- Group facts under short ## topic sections (projects, decisions, preferences, tools, open threads).
- Keep only durable, still-true facts; merge duplicates; drop anything stale or one-off.
- Use absolute dates (e.g. "2026-07-05"), never "yesterday" or "last week".
- Be specific and grounded in the digests — never invent facts.
- Keep the whole note under 120 lines.`;
}

/** Clean the model reply: trim, unwrap a full-body code fence, sanity-check. */
export function parseConsolidation(raw: string): string {
  let body = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fence?.[1]) body = fence[1].trim();
  if (body.length === 0) throw new Error("Consolidation reply was empty.");
  if (body.length < 20) throw new Error("Consolidation reply was too short to be a memory note.");
  return body;
}

export interface MemoryNoteOptions {
  /** ISO date of this consolidation run. */
  updated: string;
  /** How many digests were folded in. */
  digestCount: number;
  baseTags: string[];
}

/** Render the full memory note (frontmatter + heading + body). */
export function renderMemoryNote(body: string, opts: MemoryNoteOptions): string {
  const fm = buildFrontmatter({
    title: MEMORY_NOTE_BASENAME,
    type: "claude-memory",
    source: "claude-companion",
    updated: opts.updated,
    digests: opts.digestCount,
    tags: normalizeTags(opts.baseTags),
  });
  return `${fm}\n\n# ${MEMORY_NOTE_BASENAME}\n\n${body}\n`;
}
