// Note enrichment (right-click "Enrich with Claude"): model-driven lint of a
// note's markdown, returned as a full cleaned copy and turned into reviewable
// edits by diffToEdits in main.ts. Pure — the model call is injected there.

export const LINT_SYSTEM =
  "You are a meticulous markdown copyeditor. Clean up the note the user sends and reply with the FULL corrected note and nothing else. " +
  "Fix spelling and grammar, markdown syntax (headings, lists, links, emphasis), inconsistent spacing, and obvious formatting issues. " +
  "Never change meaning, never remove information, never add commentary, never touch YAML frontmatter, code blocks, or wikilinks ([[...]]). " +
  "Preserve the note's structure and voice. If the note is already clean, reply with it unchanged.";

export function buildLintUser(content: string): string {
  return `NOTE:\n\n${content}`;
}

/** Output-token ceiling for a lint pass — the reply is the whole note. */
export function lintMaxTokens(content: string): number {
  return Math.min(Math.ceil(content.length / 3) + 1024, 16000);
}

/**
 * Validate a lint reply against the original: strip one wrapping code fence,
 * reject empty, unchanged-but-noise, and suspiciously short results (a reply
 * under half the original length almost certainly dropped content). Returns
 * null when the reply can't be trusted — the caller then skips linting.
 */
export function parseLintResponse(raw: string, original: string): string | null {
  let text = raw.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fence && fence[1] !== undefined) text = fence[1].trim();
  if (text.length === 0) return null;
  if (text === original.trim()) return null; // no changes — nothing to review
  if (text.length < original.trim().length * 0.5) return null;
  // Match the original's trailing-newline convention so no-op tails don't diff.
  return original.endsWith("\n") ? `${text}\n` : text;
}
