import { describe, expect, it } from "vitest";
import {
  batchDiffCounts,
  batchFileSelection,
  createBatchDiffState,
  toggleBatchFile,
  toggleBatchHunk,
} from "../src/view/batchDiffState";
import type { BatchLinkPlan } from "../src/links/batch";

const plans: BatchLinkPlan[] = [
  {
    path: "Inbox/alpha.md",
    basename: "alpha",
    original: "Alpha",
    plan: { hunks: [
      { start: 0, oldText: "Alpha", newText: "[[Alpha]]", lines: [], lineno: 1 },
      { start: 6, oldText: "Beta", newText: "[[Beta]]", lines: [], lineno: 2 },
    ] },
  },
  {
    path: "Inbox/beta.md",
    basename: "beta",
    original: "Gamma",
    plan: { hunks: [
      { start: 0, oldText: "Gamma", newText: "[[Gamma]]", lines: [], lineno: 1 },
    ] },
  },
];

describe("batch diff selection state", () => {
  it("catches a regression that starts a batch review with any hunk unselected", () => {
    const state = createBatchDiffState(plans);

    expect(state.selected).toEqual([[true, true], [true]]);
    expect(batchDiffCounts(state)).toEqual({ selectedFiles: 2, selectedHunks: 3 });
  });

  it("catches a regression that toggles only part of a selected file", () => {
    const initial = createBatchDiffState(plans);
    const next = toggleBatchFile(initial, 0, false);

    expect(next.selected).toEqual([[false, false], [true]]);
    expect(initial.selected).toEqual([[true, true], [true]]);
    expect(batchDiffCounts(next)).toEqual({ selectedFiles: 1, selectedHunks: 1 });
  });

  it("catches a regression that does not expose a partly selected file as indeterminate", () => {
    const state = toggleBatchHunk(createBatchDiffState(plans), 0, 1, false);

    expect(state.selected).toEqual([[true, false], [true]]);
    expect(batchFileSelection(state, 0)).toEqual({ checked: false, indeterminate: true });
    expect(batchFileSelection(state, 1)).toEqual({ checked: true, indeterminate: false });
    expect(batchDiffCounts(state)).toEqual({ selectedFiles: 2, selectedHunks: 2 });
  });
});
