// Inline edit review session in current-document offsets. Pure; the CM6 layer maps anchors through transactions.

import type { EditPlan } from "../edit/diff";

export type HunkStatus = "pending" | "accepted" | "rejected";

export interface InlineHunk {
  index: number;
  from: number;
  to: number;
  oldText: string;
  newText: string;
  status: HunkStatus;
}

export interface InlineDiffSession {
  path: string;
  description?: string;
  hunks: InlineHunk[];
}

export interface InlineChange {
  from: number;
  to: number;
  insert: string;
}

export interface SessionMeta {
  path: string;
  description?: string;
}

const DRIFT = "The note changed before review — the proposed edit no longer applies.";

function withMeta(meta: SessionMeta, hunks: InlineHunk[]): InlineDiffSession {
  return { path: meta.path, ...(meta.description !== undefined ? { description: meta.description } : {}), hunks };
}

export function createSession(content: string, plan: EditPlan, meta: SessionMeta): InlineDiffSession {
  const hunks = plan.hunks.map((h, index): InlineHunk => {
    const to = h.start + h.oldText.length;
    if (content.slice(h.start, to) !== h.oldText) throw new Error(DRIFT);
    return { index, from: h.start, to, oldText: h.oldText, newText: h.newText, status: "pending" };
  });
  return withMeta(meta, hunks);
}

export function createRangeSession(content: string, range: { from: number; to: number; newText: string }, meta: SessionMeta): InlineDiffSession {
  const oldText = content.slice(range.from, range.to);
  if (oldText.length === 0) throw new Error("Nothing selected.");
  return withMeta(meta, [{ index: 0, from: range.from, to: range.to, oldText, newText: range.newText, status: "pending" }]);
}

export function planResolve(
  s: InlineDiffSession,
  index: number,
  decision: "accepted" | "rejected",
  content: string,
): { change: InlineChange | null; drifted: boolean } {
  const hunk = s.hunks[index];
  if (!hunk || hunk.status !== "pending") return { change: null, drifted: false };
  if (decision === "rejected") return { change: null, drifted: false };
  if (content.slice(hunk.from, hunk.to) !== hunk.oldText) return { change: null, drifted: true };
  return { change: { from: hunk.from, to: hunk.to, insert: hunk.newText }, drifted: false };
}

export function markHunk(s: InlineDiffSession, index: number, status: HunkStatus): InlineDiffSession {
  return { ...s, hunks: s.hunks.map((h) => (h.index === index ? { ...h, status } : h)) };
}

export function mapSession(s: InlineDiffSession, mapPos: (pos: number, assoc: -1 | 1) => number): InlineDiffSession {
  return { ...s, hunks: s.hunks.map((h) => ({ ...h, from: mapPos(h.from, 1), to: mapPos(h.to, -1) })) };
}

export function pendingHunks(s: InlineDiffSession): InlineHunk[] {
  return s.hunks.filter((h) => h.status === "pending");
}

export function decisions(s: InlineDiffSession): boolean[] {
  return s.hunks.map((h) => h.status === "accepted");
}
