// Fenced code blocks, located line by line. A fence may sit behind indentation,
// blockquote markers, or a list marker (list items, callouts). It closes on a
// line in the same blockquote depth, without a list marker, of the same
// character at least as long; leaving its blockquote ends it; an unclosed fence
// runs to the end of the note. An unclosed ``` indented four or more columns is
// indented code, not a fence. Pure.

export interface Fence {
  char: "`" | "~";
  length: number;
  /** Blockquote depth (`>` markers) the fence sits in. */
  depth: number;
  /** Column of the fence run, after blockquote markers. */
  column: number;
  /** Whitespace columns right before the fence run, after any list marker. */
  indent: number;
}

interface LineParts {
  depth: number;
  listMarker: boolean;
  column: number;
  indent: number;
  rest: string;
}

const width = (ws: string): number => [...ws].reduce((n, ch) => (ch === "\t" ? n + 4 - (n % 4) : n + 1), 0);

function parts(line: string): LineParts {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const quote = /^(?:[ \t]*>)*/.exec(text)?.[0] ?? "";
  const after = text.slice(quote.length);
  const m = /^([ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+)?/.exec(after);
  const lead = m?.[1] ?? "";
  const marker = m?.[2] ?? "";
  return {
    depth: quote.split(">").length - 1,
    listMarker: marker !== "",
    column: width(lead) + marker.length,
    indent: marker ? 0 : width(lead),
    rest: after.slice(lead.length + marker.length),
  };
}

/** The fence `line` opens by its own syntax, or null. Backtick info strings may not contain backticks. */
export function fenceOpen(line: string): Fence | null {
  const p = parts(line);
  const m = /^(`{3,}|~{3,})(.*)$/.exec(p.rest);
  if (!m) return null;
  const run = m[1]!;
  if (run[0] === "`" && m[2]!.includes("`")) return null;
  return { char: run[0] as Fence["char"], length: run.length, depth: p.depth, column: p.column, indent: p.indent };
}

/** Whether `line` closes `open`: same blockquote depth, no list marker, at most three columns right of the opener. */
export function closesFence(line: string, open: Fence): boolean {
  const p = parts(line);
  if (p.listMarker || p.depth !== open.depth || p.column > open.column + 3) return false;
  const m = /^(`{3,}|~{3,})[ \t]*$/.exec(p.rest);
  return !!m && m[1]![0] === open.char && m[1]!.length >= open.length;
}

/** Index of the last line of the fence opened at `start`: its closer, the line before its blockquote ends, or the last line. */
export function fenceEnd(lines: readonly string[], start: number, open: Fence): number {
  for (let j = start + 1; j < lines.length; j++) {
    if (parts(lines[j]!).depth < open.depth) return j - 1;
    if (closesFence(lines[j]!, open)) return j;
  }
  return lines.length - 1;
}

/** The fence lines[i] opens, or null; an unclosed opener indented four or more columns does not open one. */
export function fenceAt(lines: readonly string[], i: number): Fence | null {
  const open = fenceOpen(lines[i] ?? "");
  if (!open || open.indent < 4) return open;
  const end = fenceEnd(lines, i, open);
  return end > i && closesFence(lines[end]!, open) ? open : null;
}

/** One flag per line: true for fence lines and every line between them. */
export function fencedLines(lines: readonly string[]): boolean[] {
  const out = lines.map(() => false);
  for (let i = 0; i < lines.length; i++) {
    const open = fenceAt(lines, i);
    if (!open) continue;
    const end = fenceEnd(lines, i, open);
    for (let j = i; j <= end; j++) out[j] = true;
    i = end;
  }
  return out;
}
