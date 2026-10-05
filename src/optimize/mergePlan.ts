import { buildFrontmatter } from "../indexing/frontmatter";
import { tagId } from "../tags/vocabulary";

export interface NoteTagInput {
  path: string;
  frontmatterTags: string[];
  inline: Array<{ tag: string; start: number; end: number }>;
}
export interface NoteMergePlan {
  path: string;
  before: string[];
  after: string[];
  inline: Array<{ start: number; end: number; from: string; to: string }>;
}

export const OPTIMIZE_OUTPUT_ROOT = "Claude/Optimize";

const wikiTarget = (path: string) => path.replace(/\.md$/i, "");

export function collapseMerges(merges: Array<{ from: string; to: string }>): { map: Map<string, string>; cycles: string[][]; dropped: string[] } {
  const direct = new Map<string, string>();
  for (const m of merges) {
    const from = tagId(m.from);
    const to = tagId(m.to);
    if (!from || !to || from === to || direct.has(from)) continue;
    direct.set(from, to);
  }
  const map = new Map<string, string>();
  const cycles: string[][] = [];
  const reported = new Set<string>();
  for (const start of direct.keys()) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.set(cur, path.length);
      path.push(cur);
      cur = direct.get(cur);
    }
    if (cur === undefined) {
      map.set(start, path[path.length - 1] as string);
      continue;
    }
    const cycle = path.slice(seen.get(cur));
    const first = cycle.indexOf([...cycle].sort()[0] as string);
    const rotated = [...cycle.slice(first), ...cycle.slice(0, first)];
    const key = rotated.join("|");
    if (!reported.has(key)) {
      reported.add(key);
      cycles.push(rotated);
    }
  }
  return { map, cycles, dropped: [...direct.keys()].filter((from) => !map.has(from)) };
}

export function entryId(entry: unknown): string | null {
  return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? tagId(String(entry)) : null;
}

export function mapTagList(entries: unknown[], map: ReadonlyMap<string, string>): { tags: unknown[]; changed: boolean } {
  const keep = new Set<string>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (id !== null && !map.has(id)) keep.add(id);
  }
  const out: unknown[] = [];
  const emitted = new Set<string>();
  let changed = false;
  for (const entry of entries) {
    const id = entryId(entry);
    if (id === null || !map.has(id)) {
      out.push(entry);
      continue;
    }
    changed = true;
    const target = map.get(id) as string;
    if (keep.has(target) || emitted.has(target)) continue;
    emitted.add(target);
    out.push(target);
  }
  return { tags: out, changed };
}

export function planTagMerges(map: ReadonlyMap<string, string>, notes: NoteTagInput[]): NoteMergePlan[] {
  const plans: NoteMergePlan[] = [];
  for (const note of notes) {
    const mapped = mapTagList(note.frontmatterTags, map);
    const after = mapped.tags as string[];
    const inline: NoteMergePlan["inline"] = [];
    for (const t of note.inline) {
      const from = tagId(t.tag);
      const to = map.get(from);
      if (to !== undefined) inline.push({ start: t.start, end: t.end, from, to });
    }
    if (!mapped.changed && inline.length === 0) continue;
    plans.push({ path: note.path, before: note.frontmatterTags, after, inline });
  }
  return plans;
}

const TAG_CHAR = /[\p{L}\p{N}\p{M}\p{Extended_Pictographic}_/-]/u;

function endsTag(content: string, end: number): boolean {
  const cp = content.codePointAt(end);
  return cp === undefined || !TAG_CHAR.test(String.fromCodePoint(cp));
}

export function rewriteInlineTags(
  content: string,
  edits: NoteMergePlan["inline"],
): { content: string; applied: number; skipped: number; appliedFrom: string[] } {
  let out = content;
  const appliedFrom: string[] = [];
  let skipped = 0;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (out.slice(edit.start, edit.end).toLowerCase() !== `#${edit.from}` || !endsTag(out, edit.end)) {
      skipped++;
      continue;
    }
    out = `${out.slice(0, edit.start)}#${edit.to}${out.slice(edit.end)}`;
    appliedFrom.push(edit.from);
  }
  return { content: out, applied: appliedFrom.length, skipped, appliedFrom };
}

export interface RunNoteInput {
  applied: Array<{ from: string; to: string; paths: string[] }>;
  failed: string[];
  orders: Array<{ path: string; tag: string }>;
}

export function renderRunNote(input: RunNoteInput, now: string): string {
  const notes = new Set(input.applied.flatMap((m) => m.paths));
  const frontmatter = buildFrontmatter({
    type: "optimize-run",
    created: now,
    merges: input.applied.length,
    notes: notes.size,
  });
  const lines = [frontmatter, "", "# Tag merges", ""];
  for (const m of input.applied) {
    lines.push(`- \`${m.from}\` → \`${m.to}\``);
    for (const p of m.paths) lines.push(`  - [[${wikiTarget(p)}]]`);
  }
  if (input.failed.length > 0) {
    lines.push("", "## Not rewritten", "");
    for (const p of input.failed) lines.push(`- \`${p}\``);
  }
  if (input.orders.length > 0) {
    lines.push("", "## Standing orders that trigger on a merged tag", "");
    for (const o of input.orders) lines.push(`- [[${wikiTarget(o.path)}]] — \`${o.tag}\``);
  }
  return `${lines.join("\n")}\n`;
}
