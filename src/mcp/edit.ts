// Pure Markdown edit helpers — no `obsidian` import, so they unit-test
// directly. Used by the note_update MCP tool.

/**
 * Replace the body of the first heading whose text matches `heading`
 * (case-insensitive, trimmed). The section spans from the line after the
 * heading up to the next heading of the same or higher level, or end-of-file.
 * The heading line itself is preserved. Throws if the heading is absent.
 *
 * Fenced code blocks (``` or ~~~) are tracked so `#`-prefixed lines inside a
 * fence (e.g. shell comments) are not mistaken for headings.
 *
 * NOTE: the section body is normalized on write — trailing whitespace is
 * stripped and one blank line of padding is added around the new body — so
 * this is not a byte-exact replacement.
 */
export function replaceSection(markdown: string, heading: string, newBody: string): string {
  const lines = markdown.split("\n");
  const target = heading.trim().toLowerCase();
  const isFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === target) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) throw new Error(`Section not found: ${heading}`);
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#+)\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const body = newBody.replace(/\s+$/, "");
  const replacement = [lines[start], "", body, ""];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}
