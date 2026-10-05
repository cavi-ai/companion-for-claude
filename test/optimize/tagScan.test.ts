import { describe, expect, it } from "vitest";
import { pairKey, scanTags } from "../../src/optimize/tagScan";
import { buildVocabulary } from "../../src/tags/vocabulary";

function vocabOf(counts: Record<string, number>) {
  const files: Array<{ path: string; tags: string[] }> = [];
  for (const [tag, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) files.push({ path: `${tag}-${i}.md`, tags: [tag] });
  }
  return buildVocabulary(files);
}

function find(report: ReturnType<typeof scanTags>, a: string, b: string) {
  return report.candidates.find((c) => c.id === pairKey(a, b));
}

describe("scanTags", () => {
  it("pairs separator and plural variants, fewer notes is from", () => {
    const report = scanTags({ vocab: vocabOf({ "ai-agents": 5, ai_agents: 1, llm: 4, llms: 2 }) });
    expect(find(report, "ai-agents", "ai_agents")).toMatchObject({ from: "ai_agents", to: "ai-agents", evidence: ["separator"], score: 1, fromCount: 1, toCount: 5 });
    expect(find(report, "llm", "llms")).toMatchObject({ from: "llms", to: "llm", evidence: ["plural"] });
  });

  it("breaks count ties with the longer tag as from", () => {
    const report = scanTags({ vocab: vocabOf({ llm: 2, llms: 2 }) });
    expect(find(report, "llm", "llms")).toMatchObject({ from: "llms", to: "llm" });
  });

  it("pairs each member of a bucket of more than two with the most used tag only", () => {
    const report = scanTags({ vocab: vocabOf({ "a-b": 5, ab: 2, a_b: 1 }) });
    expect(find(report, "a-b", "ab")).toBeDefined();
    expect(find(report, "a-b", "a_b")).toBeDefined();
    expect(find(report, "ab", "a_b")).toBeUndefined();
  });

  it("flags plural-loose pairs the inline resolver declines", () => {
    const report = scanTags({ vocab: vocabOf({ analysis: 4, analyses: 1, "api-key": 3, "api-keyes": 1 }) });
    expect(find(report, "analysis", "analyses")).toMatchObject({ evidence: ["plural-loose"], score: 0.7 });
  });

  it("does not strip a trailing s from words of three characters or fewer", () => {
    const report = scanTags({ vocab: vocabOf({ css: 3, cs: 2 }) });
    expect(find(report, "css", "cs")).toBeUndefined();
  });

  it("strips a trailing s from three-character words that do not end in ss", () => {
    const report = scanTags({ vocab: vocabOf({ prs: 1, pr: 4 }) });
    expect(find(report, "prs", "pr")?.evidence).toContain("plural-loose");
    const keyes = scanTags({ vocab: vocabOf({ "api-key": 3, "api-keyes": 1, llm: 4, llms: 2 }) });
    expect(find(keyes, "api-key", "api-keyes")?.evidence).toEqual(["plural-loose"]);
    expect(find(keyes, "llm", "llms")?.evidence).not.toContain("plural-loose");
  });

  it("flags token-order, not separator-only differences", () => {
    const report = scanTags({ vocab: vocabOf({ "design-system": 4, "system-design": 1 }) });
    expect(find(report, "design-system", "system-design")).toMatchObject({ evidence: ["token-order"], score: 0.8 });
    const same = scanTags({ vocab: vocabOf({ "ai-agents": 3, ai_agents: 1 }) });
    expect(find(same, "ai-agents", "ai_agents")?.evidence).toEqual(["separator"]);
  });

  it("flags a plain tag equal to the leaf of exactly one nested tag", () => {
    const one = scanTags({ vocab: vocabOf({ agents: 1, "ai/agents": 4 }) });
    expect(find(one, "agents", "ai/agents")).toMatchObject({ from: "agents", evidence: ["leaf"], score: 0.6 });
    const two = scanTags({ vocab: vocabOf({ agents: 1, "ai/agents": 4, "ops/agents": 3 }) });
    expect(find(two, "agents", "ai/agents")).toBeUndefined();
  });

  it("flags typos at distance 1 for tags of 6+ chars with an established target", () => {
    const report = scanTags({ vocab: vocabOf({ frontend: 4, fronted: 1, frontent: 1 }) });
    expect(find(report, "frontend", "fronted")).toMatchObject({ evidence: ["typo"], score: 0.6 });
    expect(find(report, "frontend", "frontent")).toBeDefined();
    const transposed = scanTags({ vocab: vocabOf({ networking: 3, netwroking: 1 }) });
    expect(find(transposed, "networking", "netwroking")?.evidence).toContain("typo");
    const short = scanTags({ vocab: vocabOf({ react: 3, reakt: 1 }) });
    expect(short.candidates).toEqual([]);
    const single = scanTags({ vocab: vocabOf({ frontend: 1, fronted: 1 }) });
    expect(find(single, "frontend", "fronted")).toBeUndefined();
  });

  it("does not report a typo on a pair that already has plural", () => {
    const report = scanTags({ vocab: vocabOf({ database: 3, databases: 1 }) });
    expect(find(report, "database", "databases")?.evidence).toEqual(["plural"]);
  });

  it("finds typos through single-character deletions, including first-character and transposition typos", () => {
    const report = scanTags({ vocab: vocabOf({ frontend: 4, fronted: 1, networking: 3, netwroking: 1, database: 3, katabase: 1 }) });
    expect(find(report, "frontend", "fronted")?.evidence).toContain("typo");
    expect(find(report, "networking", "netwroking")?.evidence).toContain("typo");
    expect(find(report, "database", "katabase")?.evidence).toContain("typo");
  });

  it("scans 8,000 eligible tags sharing one prefix in under a second and still finds a typo", () => {
    const counts: Record<string, number> = { frontend: 3, fronted: 1 };
    for (let i = 0; i < 8000; i++) counts[`proj-${(i * 2654435761 % 4294967296).toString(36)}-${i.toString(36)}`] = 1;
    const vocab = vocabOf(counts);
    const start = performance.now();
    const report = scanTags({ vocab });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(find(report, "frontend", "fronted")?.evidence).toContain("typo");
  });

  it("does not call tags that differ only in digits typos", () => {
    const counts: Record<string, number> = {};
    for (let d = 1; d <= 28; d++) counts[`2024/05/${String(d).padStart(2, "0")}`] = 2;
    expect(scanTags({ vocab: vocabOf(counts) }).candidates).toEqual([]);
    expect(scanTags({ vocab: vocabOf({ "chapter-1": 3, "chapter-2": 2 }) }).candidates).toEqual([]);
  });

  it("does not add typo evidence to a pair that shares a plural form", () => {
    const report = scanTags({ vocab: vocabOf({ "ml-models": 1, "ml-model": 2, mlmodel: 5 }) });
    expect(find(report, "ml-model", "ml-models")?.evidence ?? []).not.toContain("typo");
  });

  it("skips a semantic comparison between centroids of different lengths", () => {
    const vocab = vocabOf({ ml: 1, "machine-learning": 4 });
    const vecs: Record<string, number[]> = { ml: [1, 0], "machine-learning": [1, 0, 50, 50] };
    expect(scanTags({ vocab, centroid: (t) => vecs[t] ?? null }).candidates).toEqual([]);
  });

  it("adds semantic candidates only when a centroid is given, one per low-consumer tag", () => {
    const vocab = vocabOf({ ml: 1, "machine-learning": 4, cooking: 4 });
    const vecs: Record<string, number[]> = { ml: [1, 0.1], "machine-learning": [1, 0.12], cooking: [0, 1] };
    expect(scanTags({ vocab }).candidates).toEqual([]);
    const report = scanTags({ vocab, centroid: (t) => vecs[t] ?? null });
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({ from: "ml", to: "machine-learning", evidence: ["semantic"] });
    expect(report.candidates[0]?.score).toBeGreaterThan(0.86);
  });

  it("skips dismissed pairs, sorts by score then fromCount then id, and caps with dropped", () => {
    const vocab = vocabOf({ llm: 4, llms: 2, cache: 5, caches: 1, "design-system": 4, "system-design": 1 });
    const all = scanTags({ vocab });
    expect(all.candidates.map((c) => c.id)).toEqual([pairKey("cache", "caches"), pairKey("llm", "llms"), pairKey("design-system", "system-design")]);
    const dismissed = scanTags({ vocab, dismissed: new Set([pairKey("llm", "llms")]) });
    expect(dismissed.candidates.map((c) => c.id)).not.toContain(pairKey("llm", "llms"));
    const capped = scanTags({ vocab, limits: { maxCandidates: 1 } });
    expect(capped.candidates).toHaveLength(1);
    expect(capped.dropped).toBe(2);
  });

  it("reports totals and single-use count", () => {
    const report = scanTags({ vocab: vocabOf({ a: 1, b: 1, c: 3 }) });
    expect(report).toMatchObject({ totalTags: 3, singleUse: 2, dropped: 0 });
  });

  it("scans 2,000 tags in under a second without comparing all pairs", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) counts[`topic${i.toString(36)}x${(i * 7919).toString(36)}`] = 1 + (i % 4);
    const vocab = vocabOf(counts);
    const start = performance.now();
    const report = scanTags({ vocab });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(report.totalTags).toBe(2000);
  });
});
