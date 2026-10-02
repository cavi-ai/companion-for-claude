// Review or discard one queued order edit. Stale text never reaches the vault: the edit is re-planned against the live note first.

import { Notice, TFile, type App } from "obsidian";
import { planEdits } from "../edit/diff";
import { reviewAndApply } from "../edit/reviewAndApply";
import { removeEdit, replaceEdits, type QueuedEdit } from "./editQueue";

export interface QueueReviewDeps {
  app: App;
  getQueue(): QueuedEdit[];
  setQueue(queue: QueuedEdit[]): Promise<void>;
  inlineEnabled(): boolean;
  onChanged(): void;
  review?: typeof reviewAndApply;
}

export async function reviewQueuedEdit(deps: QueueReviewDeps, id: string): Promise<void> {
  const item = deps.getQueue().find((queued) => queued.id === id);
  if (!item) return;
  const file = deps.app.vault.getAbstractFileByPath(item.path);
  if (!(file instanceof TFile)) {
    new Notice(`Note missing: ${item.path}`);
    return;
  }
  let plan: ReturnType<typeof planEdits>;
  try {
    plan = planEdits(await deps.app.vault.cachedRead(file), item.edits);
  } catch {
    new Notice(`This edit no longer matches ${item.path}. Discard it or edit the note.`);
    return;
  }
  const result = await (deps.review ?? reviewAndApply)(deps.app, file, plan, item.description, { inlineEnabled: deps.inlineEnabled() });
  if (result.cancelled) return;
  const queue = deps.getQueue();
  await deps.setQueue(result.remaining.length === 0 ? removeEdit(queue, id) : replaceEdits(queue, id, result.remaining));
  deps.onChanged();
}

export async function discardQueuedEdit(deps: Pick<QueueReviewDeps, "getQueue" | "setQueue" | "onChanged">, id: string): Promise<void> {
  await deps.setQueue(removeEdit(deps.getQueue(), id));
  deps.onChanged();
}
