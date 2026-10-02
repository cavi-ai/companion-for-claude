// Review a planned edit (inline or modal) and apply the accepted hunks; shared by chat and queued order edits.

import type { App, TFile } from "obsidian";
import { reviewEdits, type ReviewEditsDeps } from "../editor/reviewEdits";
import { applyPlan, type EditPlan, type ProposedEdit } from "./diff";

export interface ReviewApplyResult { applied: number; total: number; remaining: ProposedEdit[]; cancelled: boolean }

const asEdit = (hunk: EditPlan["hunks"][number]): ProposedEdit => ({ old_str: hunk.oldText, new_str: hunk.newText });

export async function reviewAndApply(
  app: App,
  file: TFile,
  plan: EditPlan,
  description: string | undefined,
  opts: { inlineEnabled: boolean; signal?: AbortSignal },
  deps?: ReviewEditsDeps,
): Promise<ReviewApplyResult> {
  const total = plan.hunks.length;
  const outcome = await reviewEdits(
    app,
    { file, plan, ...(description !== undefined ? { description } : {}) },
    { inlineEnabled: opts.inlineEnabled, ...(opts.signal ? { signal: opts.signal } : {}) },
    deps,
  );
  const accepted = outcome.accepted;
  if (!accepted || opts.signal?.aborted) return { applied: 0, total, remaining: plan.hunks.map(asEdit), cancelled: true };

  // Inline review already edited the live buffer; the modal path applies under the write lock.
  if (outcome.mode === "modal") await app.vault.process(file, (current) => applyPlan(current, plan, accepted));
  return {
    applied: accepted.filter(Boolean).length,
    total,
    remaining: plan.hunks.filter((_, index) => !accepted[index]).map(asEdit),
    cancelled: false,
  };
}
