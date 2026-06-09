export interface EditorPosition {
  line: number;
  ch?: number;
}

export function abbreviateNoteName(name: string | null | undefined, max = 28): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "No note";
  if (trimmed.length <= max) return trimmed;
  if (max <= 3) return trimmed.slice(0, max);
  return `${trimmed.slice(0, max - 1)}…`;
}

export function selectionLineLabel(from: EditorPosition | null | undefined, to: EditorPosition | null | undefined): string {
  if (!from || !to) return "No selection";
  const start = Math.min(from.line, to.line) + 1;
  const end = Math.max(from.line, to.line) + 1;
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

export function selectionLineLabelFromText(content: string, selected: string): string | null {
  const needle = selected.trim();
  if (!needle) return null;
  let startIdx = content.indexOf(needle);
  let matched = needle;
  if (startIdx < 0) {
    const compactNeedle = compactWhitespace(needle);
    const compactContent = compactWhitespace(content);
    const compactIdx = compactContent.indexOf(compactNeedle);
    if (compactIdx < 0) return null;
    const before = compactContent.slice(0, compactIdx);
    startIdx = contentIndexAfterCompactedPrefix(content, before);
    matched = needle;
  }
  const endIdx = startIdx + matched.length;
  const startLine = lineAtIndex(content, startIdx);
  const endLine = lineAtIndex(content, Math.max(startIdx, endIdx - 1));
  return selectionLineLabel({ line: startLine }, { line: endLine });
}

function lineAtIndex(text: string, idx: number): number {
  return text.slice(0, idx).split("\n").length - 1;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function contentIndexAfterCompactedPrefix(content: string, prefix: string): number {
  if (!prefix) return 0;
  let compacted = "";
  for (let i = 0; i < content.length; i++) {
    if (/\s/.test(content[i])) {
      if (compacted && !compacted.endsWith(" ")) compacted += " ";
    } else {
      compacted += content[i];
    }
    if (compacted.trimEnd().length >= prefix.length) return i + 1;
  }
  return 0;
}
