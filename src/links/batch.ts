// Batch link planning and application: build reviewable per-note link plans,
// then apply the selected hunks while isolating stale or failed files.

import { applyPlan, planEdits, type EditPlan } from "../edit/diff";
import { mentionEdits } from "./suggest";
import { findUnlinkedMentions, type LinkCandidate } from "./unlinkedMentions";

export interface BatchLinkEntry {
  path: string;
  basename: string;
  content: string;
}

export interface BatchLinkPlan {
  path: string;
  basename: string;
  original: string;
  plan: EditPlan;
}

export type BatchLinkSelection = boolean[][];

export interface BatchLinkApplyResult {
  appliedFiles: number;
  appliedHunks: number;
  conflicts: string[];
  failures: Array<{ path: string; message: string }>;
}

class BatchLinkConflictError extends Error {}

/** Build one reviewable edit plan per note with at least one usable mention. */
export function planBatchLinks(entries: BatchLinkEntry[], candidates: LinkCandidate[]): BatchLinkPlan[] {
  const plans: BatchLinkPlan[] = [];
  for (const entry of entries) {
    const mentions = findUnlinkedMentions(entry.content, candidates, entry.path);
    const edits = mentionEdits(entry.content, mentions);
    if (edits.length === 0) continue;
    plans.push({
      path: entry.path,
      basename: entry.basename,
      original: entry.content,
      plan: planEdits(entry.content, edits),
    });
  }
  return plans.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Apply selected plans independently. A note that changed after review is a
 * conflict, while planning or process/write errors are recorded per file.
 */
export async function applyBatchLinkPlans(
  plans: BatchLinkPlan[],
  selected: BatchLinkSelection,
  deps: { process(path: string, transform: (current: string) => string): Promise<void> },
): Promise<BatchLinkApplyResult> {
  const result: BatchLinkApplyResult = { appliedFiles: 0, appliedHunks: 0, conflicts: [], failures: [] };

  for (let i = 0; i < plans.length; i++) {
    const item = plans[i]!;
    const accepted = selected[i] ?? [];
    if (!accepted.some(Boolean)) continue;

    try {
      await deps.process(item.path, (current) => {
        if (current !== item.original) throw new BatchLinkConflictError();
        return applyPlan(current, item.plan, accepted);
      });
      result.appliedFiles++;
      result.appliedHunks += accepted.filter(Boolean).length;
    } catch (error) {
      if (error instanceof BatchLinkConflictError) {
        result.conflicts.push(item.path);
        continue;
      }
      result.failures.push({ path: item.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
