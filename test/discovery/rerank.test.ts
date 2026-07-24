import { describe, expect, it, vi } from "vitest";
import { rankCandidates } from "../../src/discovery/rank";
import { buildRerankRequest, parseRerankResponse, rerankCandidates } from "../../src/discovery/rerank";
import type { DiscoveryCandidate } from "../../src/discovery/types";
import type { Provider } from "../../src/providers/types";

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

const query = { text: "Question", projectPath: "P.md" };
const ranked = rankCandidates(query, [
  candidate("a", { title: "capturedContent", abstract: "A" }),
  candidate("b", { title: "Second" }),
], new Date("2026-01-01T00:00:00Z"));

describe("scholarly discovery model rerank trust boundary", () => {
  it("accepts only an exact permutation of known candidate IDs", () => {
    expect(parseRerankResponse('{"order":[{"id":"b","reason":"Direct"},{"id":"a","reason":"Context"}]}', ["a", "b"]).order.map(({ id }) => id)).toEqual(["b", "a"]);
    expect(() => parseRerankResponse('{"order":[{"id":"a","reason":"Only"}]}', ["a", "b"])).toThrow(/every candidate exactly once/i);
    expect(() => parseRerankResponse('{"order":[{"id":"a","reason":"One"},{"id":"x","reason":"Unknown"}]}', ["a", "b"])).toThrow(/unknown candidate/i);
    expect(() => parseRerankResponse('{"order":[{"id":"a","reason":"One"},{"id":"a","reason":"Again"}]}', ["a", "b"])).toThrow(/every candidate exactly once/i);
  });

  it("rejects responses outside the required object shape and clips reasons", () => {
    expect(() => parseRerankResponse('[{"id":"a","reason":"No object"}]', ["a"])).toThrow(/JSON object/i);
    expect(() => parseRerankResponse('{"order":[{"id":"a","reason":1}]}', ["a"])).toThrow(/reason/i);
    const parsed = parseRerankResponse(JSON.stringify({ order: [{ id: "a", reason: "x".repeat(301) }] }), ["a"]);
    expect(parsed.order[0]?.reason).toBe("x".repeat(300));
  });

  it("excludes captured source content and unrelated notes from the request", () => {
    const safeRanked = rankCandidates(query, [candidate("a", { title: "Safe title" })], new Date("2026-01-01T00:00:00Z"));
    const request = buildRerankRequest(query, safeRanked, "model-id");
    expect(request.messages[0]?.content).toContain('"id":"a"');
    expect(request.messages[0]?.content).not.toContain("capturedContent");
    expect(request.temperature).toBe(0);
  });

  it("bounds every candidate projection to 4,000 characters", () => {
    const longRanked = rankCandidates(query, [candidate("long", {
      title: "T".repeat(2_000),
      authors: ["A".repeat(2_000)],
      abstract: "B".repeat(10_000),
    })], new Date("2026-01-01T00:00:00Z"));
    const request = buildRerankRequest(query, longRanked, "model-id");
    const payload = JSON.parse(String(request.messages[0]?.content)) as { candidates: unknown[] };
    expect(JSON.stringify(payload.candidates[0]).length).toBeLessThanOrEqual(4_000);
  });

  it("calls exactly one resolved provider and preserves deterministic evidence without mutation", async () => {
    const before = structuredClone(ranked);
    const complete = vi.fn(async () => '{"order":[{"id":"b","reason":"Best"},{"id":"a","reason":"Next"}]}');
    const provider = { complete } as unknown as Provider;

    const result = await rerankCandidates(provider, query, ranked, "model-id");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.map(({ candidate }) => candidate.id)).toEqual(["b", "a"]);
    expect(result.map(({ modelRank }) => modelRank)).toEqual([1, 2]);
    expect(result.find(({ candidate }) => candidate.id === "a")?.factors).toBe(ranked.find(({ candidate }) => candidate.id === "a")?.factors);
    expect(result.find(({ candidate }) => candidate.id === "a")?.deterministicRank).toBe(ranked.find(({ candidate }) => candidate.id === "a")?.deterministicRank);
    expect(ranked).toEqual(before);
  });
});
