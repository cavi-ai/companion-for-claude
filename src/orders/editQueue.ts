// Edits an order run proposed, held until the user reviews them in the Inbox. Pure, never mutates.

import type { ProposedEdit } from "../edit/diff";

export interface QueuedEdit {
  id: string;
  orderId: string;
  orderName: string;
  runPath: string;
  path: string;
  edits: ProposedEdit[];
  description?: string;
  createdAt: number;
}

function isEdit(value: unknown): value is ProposedEdit {
  const edit = value as { old_str?: unknown; new_str?: unknown } | null;
  return !!edit && typeof edit.old_str === "string" && typeof edit.new_str === "string";
}

export function normalizeEditQueue(raw: unknown): QueuedEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedEdit[] = [];
  for (const value of raw) {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== "object") continue;
    const { id, orderId, orderName, runPath, path, edits, description, createdAt } = v;
    if (![id, orderId, orderName, runPath, path].every((x) => typeof x === "string")) continue;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
    if (!Array.isArray(edits) || edits.length === 0 || !edits.every(isEdit)) continue;
    out.push({
      id: id as string,
      orderId: orderId as string,
      orderName: orderName as string,
      runPath: runPath as string,
      path: path as string,
      edits: edits.map((e) => ({ old_str: e.old_str, new_str: e.new_str })),
      ...(typeof description === "string" && description ? { description } : {}),
      createdAt,
    });
  }
  return out;
}

export function enqueueEdit(queue: QueuedEdit[], item: QueuedEdit): QueuedEdit[] {
  return queue.some((queued) => queued.id === item.id) ? queue : [...queue, item];
}

export function removeEdit(queue: QueuedEdit[], id: string): QueuedEdit[] {
  return queue.filter((queued) => queued.id !== id);
}

/** Empty `edits` removes the item. */
export function replaceEdits(queue: QueuedEdit[], id: string, edits: ProposedEdit[]): QueuedEdit[] {
  if (edits.length === 0) return removeEdit(queue, id);
  return queue.map((queued) => (queued.id === id ? { ...queued, edits } : queued));
}
