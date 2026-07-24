import { describe, expect, it } from "vitest";
import { DISCOVERY_RANKING_VERSION, DISCOVERY_RANKING_WEIGHTS, rankCandidates } from "../../src/discovery/rank";
import type { DiscoveryCandidate } from "../../src/discovery/types";

function candidate(id: string, overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    id,
    title: id,
    authors: [],
    provenance: {},
    disagreements: [],
    verification: "partial",
    ...overrides,
  };
}

describe("scholarly discovery deterministic ranking", () => {
  it("exposes every deterministic factor and stable tie breaking", () => {
    const ranked = rankCandidates({ text: "risk intervention", projectPath: "P/Project.md" }, [
      candidate("b", { title: "Risk intervention", published: "2025", openAccessUrl: "https://oa.test/b" }),
      candidate("a", { title: "Other", published: "2010" }),
    ], new Date("2026-01-01T00:00:00Z"));
    expect(ranked[0]?.candidate.id).toBe("b");
    expect(Object.keys(ranked[0]?.factors ?? {}).sort()).toEqual(["citationRelationship", "metadataCompleteness", "openAccess", "projectOverlap", "queryRelevance", "recency"]);
    expect(ranked[0]?.deterministicRank).toBe(1);
  });

  it("uses candidate ID ascending as the final tie breaker without mutating input", () => {
    const candidates = [candidate("b"), candidate("a")];
    const before = structuredClone(candidates);
    const ranked = rankCandidates({ text: "", projectPath: "" }, candidates, new Date("2026-01-01T00:00:00Z"));

    expect(ranked.map(({ candidate: item }) => item.id)).toEqual(["a", "b"]);
    expect(candidates).toEqual(before);
  });

  it("keeps all factors bounded and fixed weights normalized", () => {
    const [ranked] = rankCandidates({ text: "study", projectPath: "Study.md" }, [candidate("a", {
      title: "Study",
      authors: ["Ada"],
      published: "2999",
      publication: "Journal",
      abstract: "Study abstract",
      doi: "10.1/a",
      openAccessUrl: "https://oa.test/a",
      relationship: { seedId: "seed", direction: "references", adapter: "openalex" },
    })], new Date("2026-01-01T00:00:00Z"));

    expect(DISCOVERY_RANKING_VERSION).toBe(1);
    expect(Object.values(DISCOVERY_RANKING_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(Object.values(ranked!.factors).every((factor) => factor >= 0 && factor <= 1)).toBe(true);
    expect(ranked!.totalScore).toBeGreaterThanOrEqual(0);
    expect(ranked!.totalScore).toBeLessThanOrEqual(1);
  });
});
