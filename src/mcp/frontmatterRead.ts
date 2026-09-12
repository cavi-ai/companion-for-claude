// Leading YAML block of a note, parsed as a mapping; null when absent or malformed.
const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*$/;

export function readFrontmatter(content: string, parse: (yaml: string) => unknown): Record<string, unknown> | null {
  const opening = OPENING.exec(content);
  if (!opening) return null;
  const lines = content.slice(opening[0].length).split(/\r?\n/);
  const end = lines.findIndex((line) => CLOSING.test(line));
  if (end === -1) return null;
  try {
    const parsed = parse(lines.slice(0, end).join("\n"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
