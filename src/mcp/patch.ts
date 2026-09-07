// Block-level Markdown patching. Pure; shared by note_patch and note_update.

export type PatchTarget = { kind: "heading"; heading: string } | { kind: "block"; id: string } | { kind: "document" };
export type PatchOp = "replace" | "append" | "prepend";

export interface NotePatch {
  target: PatchTarget;
  op: PatchOp;
  content: string;
}

/** Line indices, end exclusive. */
export interface LineRange {
  start: number;
  end: number;
}

const HEADING = /^#{1,6}\s+/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const isFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);
const isBlank = (line: string | undefined): boolean => (line ?? "").trim() === "";

/** True for every line inside a fence, fence lines included. */
function fenceMap(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (isFence(line)) {
      inFence = !inFence;
      out.push(true);
      continue;
    }
    out.push(inFence);
  }
  return out;
}

export function findSection(lines: string[], heading: string): { heading: number; body: LineRange } | null {
  const target = heading.trim().toLowerCase();
  const fenced = fenceMap(lines);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const m = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(lines[i] ?? "");
    if (m?.[1] && m[2]?.trim().toLowerCase() === target) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const m = /^(#+)\s+/.exec(lines[i] ?? "");
    if (m?.[1] && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return { heading: start, body: { start: start + 1, end } };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findBlock(lines: string[], id: string): { range: LineRange; idLine: number; inline: boolean } | null {
  const fenced = fenceMap(lines);
  const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`);
  let idLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!fenced[i] && marker.test(lines[i] ?? "")) {
      idLine = i;
      break;
    }
  }
  if (idLine === -1) return null;
  const line = lines[idLine] ?? "";
  if (/^\s*\^/.test(line)) {
    // Standalone id: the block is the run of lines above it — a whole fence when it ends one.
    let end = idLine - 1;
    while (end >= 0 && isBlank(lines[end])) end -= 1;
    if (end < 0) return null;
    let start = end;
    if (isFence(lines[end] ?? "")) {
      start = end - 1;
      while (start >= 0 && !isFence(lines[start] ?? "")) start -= 1;
      if (start < 0) return null;
    } else {
      while (start > 0 && !isBlank(lines[start - 1]) && !HEADING.test(lines[start - 1] ?? "")) start -= 1;
    }
    return { range: { start, end: end + 1 }, idLine, inline: false };
  }
  const item = LIST_ITEM.exec(line);
  if (item) {
    const indent = item[1]!.length;
    let end = idLine + 1;
    while (end < lines.length && !isBlank(lines[end]) && (/^\s*/.exec(lines[end] ?? "")?.[0].length ?? 0) > indent) end += 1;
    return { range: { start: idLine, end }, idLine, inline: true };
  }
  let start = idLine;
  while (start > 0 && !isBlank(lines[start - 1]) && !HEADING.test(lines[start - 1] ?? "") && !isFence(lines[start - 1] ?? "") && !LIST_ITEM.test(lines[start - 1] ?? "")) start -= 1;
  return { range: { start, end: idLine + 1 }, idLine, inline: true };
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0] !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === "---") return i + 1;
  return 0;
}

function dropLeadingBlank(lines: string[]): string[] {
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i += 1;
  return lines.slice(i);
}

export function applyPatch(markdown: string, patch: NotePatch): string {
  const lines = markdown.split("\n");
  const content = patch.content.replace(/\s+$/, "");
  const body = content.split("\n");
  const join = (parts: string[]): string => parts.join("\n");

  switch (patch.target.kind) {
    case "heading": {
      const section = findSection(lines, patch.target.heading);
      if (!section) throw new Error(`Section not found: ${patch.target.heading}`);
      const { start, end } = section.body;
      if (patch.op === "replace") return join([...lines.slice(0, start), "", ...body, "", ...lines.slice(end)]);
      if (patch.op === "append") {
        let tail = end;
        while (tail > start && isBlank(lines[tail - 1])) tail -= 1;
        return join([...lines.slice(0, tail), ...(tail === start ? [""] : []), ...body, "", ...lines.slice(end)]);
      }
      return join([...lines.slice(0, start), "", ...body, "", ...dropLeadingBlank(lines.slice(start))]);
    }
    case "block": {
      const found = findBlock(lines, patch.target.id);
      if (!found) throw new Error(`Block not found: ^${patch.target.id}`);
      const { range, idLine, inline } = found;
      if (patch.op === "replace") {
        if (inline) {
          const last = body.length - 1;
          const kept = [...body.slice(0, last), `${body[last] ?? ""} ^${patch.target.id}`];
          return join([...lines.slice(0, range.start), ...kept, ...lines.slice(range.end)]);
        }
        return join([...lines.slice(0, range.start), ...body, ...lines.slice(range.end)]);
      }
      if (patch.op === "append") {
        const after = inline ? range.end : idLine + 1;
        return join([...lines.slice(0, after), ...body, ...lines.slice(after)]);
      }
      return join([...lines.slice(0, range.start), ...body, ...lines.slice(range.start)]);
    }
    case "document": {
      const fm = frontmatterEnd(lines);
      const head = fm > 0 ? [...lines.slice(0, fm), ""] : [];
      if (patch.op === "replace") return join([...head, ...body, ""]);
      if (patch.op === "prepend") return join([...head, ...body, "", ...dropLeadingBlank(lines.slice(fm))]);
      return `${markdown.replace(/\s+$/, "")}\n\n${content}\n`;
    }
  }
}
