import type { BatchLinkPlan, BatchLinkSelection } from "../links/batch";

export interface BatchDiffState {
  selected: BatchLinkSelection;
}

export interface BatchFileSelection {
  checked: boolean;
  indeterminate: boolean;
}

export interface BatchDiffCounts {
  selectedFiles: number;
  selectedHunks: number;
}

/** Start every proposed hunk selected, ready for the user's review. */
export function createBatchDiffState(plans: BatchLinkPlan[]): BatchDiffState {
  return { selected: plans.map((item) => item.plan.hunks.map(() => true)) };
}

/** Select or reject every hunk in one file without mutating prior state. */
export function toggleBatchFile(state: BatchDiffState, fileIndex: number, checked: boolean): BatchDiffState {
  return {
    selected: state.selected.map((file, index) => index === fileIndex ? file.map(() => checked) : [...file]),
  };
}

/** Select or reject one hunk without mutating prior state. */
export function toggleBatchHunk(state: BatchDiffState, fileIndex: number, hunkIndex: number, checked: boolean): BatchDiffState {
  return {
    selected: state.selected.map((file, index) =>
      index === fileIndex ? file.map((selected, hunk) => hunk === hunkIndex ? checked : selected) : [...file],
    ),
  };
}

/** File-checkbox state derived from its hunks. */
export function batchFileSelection(state: BatchDiffState, fileIndex: number): BatchFileSelection {
  const selected = state.selected[fileIndex] ?? [];
  const selectedHunks = selected.filter(Boolean).length;
  return {
    checked: selected.length > 0 && selectedHunks === selected.length,
    indeterminate: selectedHunks > 0 && selectedHunks < selected.length,
  };
}

/** Totals for the review summary. */
export function batchDiffCounts(state: BatchDiffState): BatchDiffCounts {
  return {
    selectedFiles: state.selected.filter((file) => file.some(Boolean)).length,
    selectedHunks: state.selected.flat().filter(Boolean).length,
  };
}
