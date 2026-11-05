// Tidy proposes bounded prose replacements. Omitted output never deletes a note.
import { applyPlan, parseProposedEdits, planEdits } from "../edit/diff";
import { maskNonProse } from "../links/unlinkedMentions";

export const LINT_SYSTEM =
  "You are a meticulous markdown copyeditor. Propose small spelling, grammar and spacing corrections without changing meaning or facts. " +
  "Reply ONLY with JSON: {\"complete\":true,\"edits\":[{\"old_str\":\"exact original prose\",\"new_str\":\"corrected prose\"}]}. " +
  "Use at most 20 edits, each under 500 characters on one line, with a unique old_str. Combine corrections on the same line into one edit. " +
  "Never edit YAML, code, links, URLs, tags or numbers. Never delete information or rewrite paragraphs. " +
  "Do not return the whole note. If no correction is needed, return {\"complete\":true,\"edits\":[]}.";

export function buildLintUser(content: string): string { return `NOTE:\n\n${content}`; }
export function lintMaxTokens(_content: string): number { return 4096; }

/** Scan quote prefixes once; repeated whitespace groups must never backtrack. */
function indentedCode(line: string): boolean {
  let offset = 0;
  while (offset < line.length) {
    let columns = 0;
    while (line[offset] === " " || line[offset] === "\t") {
      columns += line[offset++] === "\t" ? 4 - (columns % 4) : 1;
      if (columns >= 4) return true;
    }
    if (line[offset] !== ">") return false;
    offset++;
  }
  return false;
}

function editableProse(content: string): string {
  return maskNonProse(content).replace(/[^\r\n\u2028\u2029]+/g, (line) => indentedCode(line) ? " ".repeat(line.length) : line);
}

/** Only a complete edit envelope is accepted; all content outside edits survives verbatim. */
export function parseLintResponse(raw: string, original: string): string | null {
  const error = (): Error => new Error("The copyedit reply was incomplete or changed protected content. The note was not changed. Retry Tidy.");
  const json = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw error(); }
  if (!value || typeof value !== "object") throw error();
  const envelope = value as { complete?: unknown; edits?: unknown };
  if (envelope.complete !== true || !Array.isArray(envelope.edits)) throw error();
  if (envelope.edits.length === 0) return null;
  const edits = parseProposedEdits(envelope.edits);
  const prose = editableProse(original);
  for (const edit of edits) {
    const { old_str: before, new_str: after } = edit;
    const offset = original.indexOf(before);
    if (!before.trim() || !after.trim() || /[\r\n]/.test(before + after)
      || Math.max(before.length, after.length) > 500
      || offset < 0 || prose.slice(offset, offset + before.length) !== before
      || editableProse(after) !== after
      || JSON.stringify(before.match(/\d+(?:[.,]\d+)*/g)) !== JSON.stringify(after.match(/\d+(?:[.,]\d+)*/g))) throw error();
  }
  const plan = planEdits(original, edits);
  return applyPlan(original, plan, plan.hunks.map(() => true));
}
