import { describe, expect, it } from "vitest";
import type { MergeCandidate, MergeEvidence } from "../../src/optimize/tagScan";
import type { StoredVerdict } from "../../src/optimize/state";
import { createOptimizeState, removeRow, selectedMerges, swapRow, toggleRow } from "../../src/view/optimizeState";

const cand = (id: string, evidence: MergeEvidence[]): MergeCandidate => ({ id, from: `${id}-from`, to: `${id}-to`, evidence, score: 1, fromCount: 1, toCount: 5 });

describe("optimize view state", () => {
  it("starts separator and plural rows checked, every other evidence unchecked", () => {
    const kinds: MergeEvidence[] = ["separator", "plural", "plural-loose", "token-order", "leaf", "typo", "semantic"];
    const state = createOptimizeState(kinds.map((k) => cand(k, [k])));
    expect(Object.fromEntries(state.rows.map((r) => [r.id, r.checked]))).toEqual({
      separator: true, plural: true, "plural-loose": false, "token-order": false, leaf: false, typo: false, semantic: false,
    });
  });

  it("checks a row that has plural evidence alongside others", () => {
    expect(createOptimizeState([cand("x", ["typo", "plural"])]).rows[0]?.checked).toBe(true);
  });

  it("toggles, swaps from/to with counts, removes, and selects without mutating", () => {
    const start = createOptimizeState([cand("a", ["typo"]), cand("b", ["plural"])]);
    const toggled = toggleRow(start, "a", true);
    expect(start.rows[0]?.checked).toBe(false);
    expect(selectedMerges(toggled)).toEqual([{ from: "a-from", to: "a-to" }, { from: "b-from", to: "b-to" }]);
    const swapped = swapRow(toggled, "a");
    expect(swapped.rows[0]).toMatchObject({ from: "a-to", to: "a-from", fromCount: 5, toCount: 1, id: "a" });
    expect(removeRow(swapped, "a").rows.map((r) => r.id)).toEqual(["b"]);
    expect(toggled.rows[0]?.from).toBe("a-from");
  });

  const sv = (verdict: "merge" | "keep", canonical?: string, at = "t"): StoredVerdict => ({ verdict, ...(canonical ? { canonical } : {}), a: "x", b: "y", model: "m", at });

  it("starts checked on a merge verdict and unchecked on keep", () => {
    const state = createOptimizeState([
      { ...cand("m", ["semantic"]), verdict: sv("merge", "y") },
      { ...cand("k", ["semantic"]), verdict: sv("keep") },
      { ...cand("p", ["plural"]), verdict: sv("keep") },
    ]);
    expect(state.rows.map((r) => r.checked)).toEqual([true, false, true]);
  });

  it("a merge verdict whose canonical is the row's from swaps the row", () => {
    const c = { ...cand("m", ["semantic"]), from: "a", to: "b", fromCount: 1, toCount: 7, verdict: sv("merge", "a") };
    const row = createOptimizeState([c]).rows[0]!;
    expect([row.from, row.to, row.fromCount, row.toCount]).toEqual(["b", "a", 7, 1]);
  });

  it("a rebuild keeps a prior row unless its verdict changed", () => {
    const first = createOptimizeState([cand("a", ["typo"]), cand("b", ["typo"])]);
    const edited = toggleRow(first, "a", true);
    const next = createOptimizeState([cand("a", ["typo"]), { ...cand("b", ["typo"]), verdict: sv("merge", "y") }], edited);
    expect(next.rows.map((r) => r.checked)).toEqual([true, true]);
    expect(createOptimizeState([cand("a", ["typo"])], edited).rows[0]).toBe(edited.rows[0]);
  });
});
