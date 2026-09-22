import { describe, expect, it } from "vitest";
import { SIMILAR_VIEW_MESSAGES, isNoteAnchor, rankWithinBase, similarViewState } from "../../src/bases/similarView";

describe("rankWithinBase", () => {
  const related = [{ path: "A.md", score: 0.99 }, { path: "B.md", score: 0.9 }, { path: "Out.md", score: 0.8 }, { path: "C.md", score: 0.7 }];
  it("keeps only base members, drops the anchor, keeps score order, slices", () => {
    expect(rankWithinBase(related, new Set(["A.md", "B.md", "C.md"]), "A.md", 5)).toEqual([{ path: "B.md", score: 0.9 }, { path: "C.md", score: 0.7 }]);
    expect(rankWithinBase(related, new Set(["B.md", "C.md"]), "A.md", 1)).toEqual([{ path: "B.md", score: 0.9 }]);
    expect(rankWithinBase([], new Set(["B.md"]), "A.md", 5)).toEqual([]);
  });
});

describe("isNoteAnchor", () => {
  it("accepts markdown notes only", () => {
    expect(isNoteAnchor("Notes/A.md")).toBe(true);
    expect(isNoteAnchor("Books.base")).toBe(false);
    expect(isNoteAnchor(null)).toBe(false);
  });
});

describe("similarViewState", () => {
  it("orders states: semantic off, then no note, then no neighbours, then no overlap", () => {
    expect(similarViewState({ semanticEnabled: false, anchorPath: "A.md", relatedCount: 3, rankedCount: 3 })).toBe("semantic-off");
    expect(similarViewState({ semanticEnabled: true, anchorPath: null, relatedCount: 0, rankedCount: 0 })).toBe("no-note");
    expect(similarViewState({ semanticEnabled: true, anchorPath: "A.md", relatedCount: 0, rankedCount: 0 })).toBe("no-neighbours");
    expect(similarViewState({ semanticEnabled: true, anchorPath: "A.md", relatedCount: 4, rankedCount: 0 })).toBe("no-overlap");
    expect(similarViewState({ semanticEnabled: true, anchorPath: "A.md", relatedCount: 4, rankedCount: 2 })).toBe("ready");
  });
  it("has a message for every empty state", () => {
    expect(Object.keys(SIMILAR_VIEW_MESSAGES).sort()).toEqual(["no-neighbours", "no-note", "no-overlap", "semantic-off"]);
  });
});
