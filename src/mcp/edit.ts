// Pure Markdown edit helpers — no `obsidian` import. Used by the note_update MCP tool.

import { applyPatch } from "./patch";

/**
 * Replace the body of the first heading whose text matches `heading`
 * (case-insensitive, trimmed); the heading line is preserved and the new body
 * is padded with one blank line on each side. Throws if the heading is absent.
 */
export function replaceSection(markdown: string, heading: string, newBody: string): string {
  return applyPatch(markdown, { target: { kind: "heading", heading }, op: "replace", content: newBody });
}
