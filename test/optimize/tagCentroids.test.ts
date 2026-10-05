import { describe, expect, it } from "vitest";
import { tagCentroids } from "../../src/optimize/tagCentroids";
import { buildVocabulary } from "../../src/tags/vocabulary";

describe("tagCentroids", () => {
  const vocab = buildVocabulary([
    { path: "a.md", tags: ["x"] },
    { path: "b.md", tags: ["x", "y"] },
    { path: "c.md", tags: ["z"] },
  ]);

  it("averages the indexed notes of a tag and ignores unindexed ones", () => {
    const vecs: Record<string, number[]> = { "a.md": [1, 0], "b.md": [0, 1] };
    const centroid = tagCentroids(vocab, (p) => vecs[p] ?? null);
    expect(centroid("x")).toEqual([0.5, 0.5]);
    expect(centroid("y")).toEqual([0, 1]);
    expect(centroid("z")).toBeNull();
    expect(centroid("missing")).toBeNull();
  });

  it("memoizes per tag", () => {
    let calls = 0;
    const centroid = tagCentroids(vocab, () => {
      calls++;
      return [1];
    });
    centroid("x");
    centroid("x");
    expect(calls).toBe(2);
  });
});
