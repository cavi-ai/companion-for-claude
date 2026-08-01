// The apply-to-note edit model (spec 2026-07-05): validate exact-string
// replacements against a note, render them as reviewable per-hunk line diffs,
// and apply the user-accepted subset. Pure and dependency-free.

export interface ProposedEdit {
  old_str: string;
  new_str: string;
}

export interface DiffLine {
  kind: "context" | "del" | "add";
  text: string;
}

export interface Hunk {
  /** Char offset of the whole-line region in the planned content (ordering + fast-path apply). */
  start: number;
  /** The exact text this hunk removes (whole-line expanded region). */
  oldText: string;
  /** The exact text that replaces it. */
  newText: string;
  /** Rendered diff: context lines around del/add runs. */
  lines: DiffLine[];
  /** 1-based line number of the region's first line (display). */
  lineno: number;
}

export interface EditPlan {
  hunks: Hunk[];
}

const MAX_EDITS = 20;
const CONTEXT_LINES = 2;
/** Changed regions closer than this many unchanged lines merge into one hunk. */
const MERGE_GAP = 3;
/** LCS table cells cap — bigger inputs fall back to one coarse region. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Validate edits against `content` and build the reviewable plan. Throws with
 * a model-actionable message on any invalid edit (the agent loop returns it as
 * an is_error tool_result so Claude re-reads and retries).
 */
export function planEdits(content: string, edits: ProposedEdit[]): EditPlan {
  if (edits.length === 0) throw new Error("No edits provided.");
  if (edits.length > MAX_EDITS) throw new Error(`Too many edits (${edits.length}); at most ${MAX_EDITS} per proposal.`);

  const spans: Array<{ start: number; end: number; edit: ProposedEdit }> = [];
  for (const e of edits) {
    if (e.old_str.length === 0) throw new Error("old_str must not be empty.");
    if (e.old_str === e.new_str) throw new Error(`No-op edit: old_str and new_str are identical (${excerpt(e.old_str)}).`);
    const first = content.indexOf(e.old_str);
    if (first === -1) throw new Error(`old_str not found in the note: ${excerpt(e.old_str)}. Re-read the note and try again.`);
    if (content.indexOf(e.old_str, first + 1) !== -1) {
      throw new Error(`old_str matches more than once: ${excerpt(e.old_str)}. Include more surrounding text to make it unique.`);
    }
    spans.push({ start: first, end: first + e.old_str.length, edit: e });
  }

  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const cur = spans[i]!;
    // Whole-line expansion can make adjacent same-line edits collide too.
    if (regionStart(content, cur.start) < regionEnd(content, prev.end)) {
      throw new Error(`Edits overlap around: ${excerpt(cur.edit.old_str)}. Combine them into one edit.`);
    }
  }

  return { hunks: spans.map((s) => buildHunk(content, s.start, s.end, s.edit)) };
}

/**
 * Apply the accepted hunks to `content` and return the new text. `content` may
 * have drifted since planning (the user typed during review): each accepted
 * hunk is re-validated at its recorded offset, then re-located by unique
 * search; if its old text is gone or ambiguous, the whole apply throws.
 */
export function applyPlan(content: string, plan: EditPlan, accepted: boolean[]): string {
  if (accepted.length !== plan.hunks.length) {
    throw new Error(`accepted[] length ${accepted.length} does not match hunk count ${plan.hunks.length}.`);
  }
  // Locate every accepted hunk against the *current* content first, then splice
  // end→start so earlier splices never shift later offsets.
  const located: Array<{ start: number; hunk: Hunk }> = [];
  for (let i = 0; i < plan.hunks.length; i++) {
    if (!accepted[i]) continue;
    const hunk = plan.hunks[i]!;
    located.push({ start: locate(content, hunk), hunk });
  }
  located.sort((a, b) => b.start - a.start);
  // Guard against drift that made two accepted hunks resolve to overlapping
  // ranges: splicing them end→start would corrupt the note. Reject instead.
  for (let i = 1; i < located.length; i++) {
    const higher = located[i - 1]!; // larger start (sorted desc)
    const lower = located[i]!;
    if (lower.start + lower.hunk.oldText.length > higher.start) {
      throw new Error("The note changed during review — the accepted edits now overlap. Re-read the note and propose again.");
    }
  }
  let result = content;
  for (const { start, hunk } of located) {
    result = result.slice(0, start) + hunk.newText + result.slice(start + hunk.oldText.length);
  }
  return result;
}

// ---- diffToEdits ----

interface Region {
  /** Start (inclusive) / end (exclusive) line in the old text. */
  aStart: number;
  aEnd: number;
  /** Start (inclusive) / end (exclusive) line in the new text. */
  bStart: number;
  bEnd: number;
}

/**
 * Turn an old→new text pair into planEdits-compatible edits: line-level
 * changed regions, grown until each old_str is unique and merged so no two
 * edits ever overlap (the failure mode of per-mention edits on one line).
 * Regions that cannot be uniquified are skipped, never thrown on.
 */
export function diffToEdits(oldText: string, newText: string, maxEdits = MAX_EDITS): ProposedEdit[] {
  if (oldText === newText) return [];
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const regions = mergeNear(changedRegions(oldLines, newLines));

  // Reduce to the edit budget by merging the closest adjacent pairs first.
  while (regions.length > maxEdits) {
    let best = 1;
    let bestGap = Infinity;
    for (let i = 1; i < regions.length; i++) {
      const gap = regions[i]!.aStart - regions[i - 1]!.aEnd;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    const prev = regions[best - 1]!;
    const cur = regions[best]!;
    regions.splice(best - 1, 2, { aStart: prev.aStart, aEnd: cur.aEnd, bStart: prev.bStart, bEnd: cur.bEnd });
  }

  const blocks: Region[] = [];
  for (const r of regions) {
    let { aStart, aEnd, bStart, bEnd } = r;
    // Pure insertion: anchor one unchanged context line so old_str is non-empty.
    if (aStart === aEnd) {
      if (aStart > 0 && bStart > 0) {
        aStart--;
        bStart--;
      } else if (aEnd < oldLines.length && bEnd < newLines.length) {
        aEnd++;
        bEnd++;
      } else {
        continue;
      }
    }
    // Pure deletion: swallow the newline by anchoring an adjacent line, else
    // the replacement would leave a blank line behind.
    if (bStart === bEnd) {
      if (aEnd < oldLines.length && bEnd < newLines.length) {
        aEnd++;
        bEnd++;
      } else if (aStart > 0 && bStart > 0) {
        aStart--;
        bStart--;
      }
    }
    // Grow upward (context lines are unchanged, so both sides extend together)
    // until the old block occurs exactly once; skip when it never does.
    while (countOccurrences(oldText, oldLines.slice(aStart, aEnd).join("\n")) !== 1) {
      if (aStart === 0 || bStart === 0) {
        aStart = -1;
        break;
      }
      aStart--;
      bStart--;
    }
    if (aStart === -1) continue;
    // Growth can reach back into the previous block — merge (a superset of a
    // unique block is still unique).
    const prev = blocks[blocks.length - 1];
    if (prev && aStart < prev.aEnd) {
      if (aStart < prev.aStart) {
        prev.aStart = aStart;
        prev.bStart = bStart;
      }
      prev.aEnd = Math.max(prev.aEnd, aEnd);
      prev.bEnd = bEnd;
    } else {
      blocks.push({ aStart, aEnd, bStart, bEnd });
    }
  }

  const edits: ProposedEdit[] = [];
  for (const b of blocks) {
    const old_str = oldLines.slice(b.aStart, b.aEnd).join("\n");
    const new_str = newLines.slice(b.bStart, b.bEnd).join("\n");
    if (old_str !== new_str) edits.push({ old_str, new_str });
  }
  return edits;
}

/** Line-level changed regions between two texts (LCS-based; coarse fallback for huge inputs). */
function changedRegions(a: string[], b: string[]): Region[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const n = aEnd - start;
  const m = bEnd - start;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ aStart: start, aEnd: start, bStart: start, bEnd }];
  if (m === 0) return [{ aStart: start, aEnd, bStart: start, bEnd: start }];
  if (n * m > MAX_DIFF_CELLS) return [{ aStart: start, aEnd, bStart: start, bEnd }];

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[start + i] === b[start + j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const regions: Region[] = [];
  let i = 0;
  let j = 0;
  let cur: Region | null = null;
  const extend = (): Region => {
    if (!cur) cur = { aStart: start + i, aEnd: start + i, bStart: start + j, bEnd: start + j };
    return cur;
  };
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      if (cur) {
        regions.push(cur);
        cur = null;
      }
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      const r = extend();
      r.aEnd = start + i + 1;
      i++;
    } else {
      const r = extend();
      r.bEnd = start + j + 1;
      j++;
    }
  }
  while (i < n) {
    const r = extend();
    r.aEnd = start + i + 1;
    i++;
  }
  while (j < m) {
    const r = extend();
    r.bEnd = start + j + 1;
    j++;
  }
  if (cur) regions.push(cur);
  return regions;
}

/** Merge regions separated by fewer than MERGE_GAP unchanged lines. */
function mergeNear(regions: Region[]): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    const prev = out[out.length - 1];
    if (prev && r.aStart - prev.aEnd <= MERGE_GAP) {
      prev.aEnd = r.aEnd;
      prev.bEnd = r.bEnd;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return n;
}

// ---- internals ----

function locate(content: string, hunk: Hunk): number {
  if (content.slice(hunk.start, hunk.start + hunk.oldText.length) === hunk.oldText) return hunk.start;
  const first = content.indexOf(hunk.oldText);
  if (first !== -1 && content.indexOf(hunk.oldText, first + 1) === -1) return first;
  throw new Error("The note changed during review — the proposed edit no longer applies. Re-read the note and propose again.");
}

/** Expand offset back to the start of its line. */
function regionStart(content: string, offset: number): number {
  const nl = content.lastIndexOf("\n", offset - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Expand offset forward to the end of its line (exclusive of the newline). */
function regionEnd(content: string, offset: number): number {
  const nl = content.indexOf("\n", offset);
  return nl === -1 ? content.length : nl;
}

function buildHunk(content: string, start: number, end: number, edit: ProposedEdit): Hunk {
  const rs = regionStart(content, start);
  const re = regionEnd(content, Math.max(start, end - (end > start ? 1 : 0)));
  const oldText = content.slice(rs, re);
  const newText = content.slice(rs, start) + edit.new_str + content.slice(end, re);
  const lineno = content.slice(0, rs).split("\n").length;

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const body = lineDiff(oldLines, newLines);

  // Surrounding context from the file itself.
  const before = content.slice(0, Math.max(0, rs - 1)).split("\n").slice(-CONTEXT_LINES);
  const afterRaw = re >= content.length ? [] : content.slice(re + 1).split("\n").slice(0, CONTEXT_LINES);
  const lines: DiffLine[] = [
    ...(rs === 0 ? [] : before).map((text): DiffLine => ({ kind: "context", text })),
    ...body,
    ...afterRaw.map((text): DiffLine => ({ kind: "context", text })),
  ];
  return { start: rs, oldText, newText, lines, lineno };
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Minimal line-level LCS diff — small inputs only (one hunk's region). */
function lineDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

function excerpt(s: string): string {
  const one = s.replace(/\n/g, "\\n");
  return `"${one.length > 60 ? `${one.slice(0, 60)}…` : one}"`;
}
