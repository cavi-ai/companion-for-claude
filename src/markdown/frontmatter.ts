// Leading YAML frontmatter, located line by line: `---` on the first line opens
// it and the next line that is exactly `---` (trailing spaces allowed) closes it.
// An empty block is a block, so a later `---` thematic break is never mistaken
// for its end. Pure.

export interface FrontmatterBlock {
  /** The YAML between the fences, without the line break before the closing fence. */
  yaml: string;
  /** Offset of the first body character, just past the closing fence's line break. */
  end: number;
  /** Zero-based line index of the closing fence. */
  closeLine: number;
  /** Line break the opening fence uses. */
  eol: "\n" | "\r\n";
}

const FENCE = /^---[ \t]*$/;

/** End of the line starting at `from`, before any `\r\n` or `\n`. */
function lineEnd(content: string, from: number, nextLf: number): number {
  if (nextLf === -1) return content.length;
  return nextLf > from && content[nextLf - 1] === "\r" ? nextLf - 1 : nextLf;
}

export function frontmatterBlock(content: string): FrontmatterBlock | null {
  const firstLf = content.indexOf("\n");
  if (firstLf === -1 || !FENCE.test(content.slice(0, lineEnd(content, 0, firstLf)))) return null;
  const eol = content[firstLf - 1] === "\r" ? "\r\n" : "\n";
  let offset = firstLf + 1;
  let line = 1;
  while (offset <= content.length) {
    const nextLf = content.indexOf("\n", offset);
    if (FENCE.test(content.slice(offset, lineEnd(content, offset, nextLf)))) {
      const yamlEnd = offset === firstLf + 1 ? offset : content[offset - 2] === "\r" ? offset - 2 : offset - 1;
      return { yaml: content.slice(firstLf + 1, yamlEnd), end: nextLf === -1 ? content.length : nextLf + 1, closeLine: line, eol };
    }
    if (nextLf === -1) break;
    offset = nextLf + 1;
    line += 1;
  }
  return null;
}

/** The note without its leading frontmatter block. */
export function stripFrontmatter(content: string): string {
  const block = frontmatterBlock(content);
  return block ? content.slice(block.end) : content;
}

/** Leading YAML block parsed as a mapping; null when absent, malformed, or not a mapping. */
export function readFrontmatter(content: string, parse: (yaml: string) => unknown): Record<string, unknown> | null {
  const block = frontmatterBlock(content);
  if (!block) return null;
  try {
    const parsed = parse(block.yaml);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (e) {
    console.debug("Claude Companion: frontmatter YAML parse failed", e);
    return null;
  }
}
