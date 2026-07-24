import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { IntelligenceFinding } from "../../src/research/intelligence";
import { buildNarrativeCacheKey, buildNarrativeRequest, fingerprintIntelligenceSnapshot, parseNarrativeResponse } from "../../src/research/intelligenceNarrative";
import type { ResearchRecord } from "../../src/research/types";

function makeSnapshot() {
  const records: ResearchRecord[] = [
    { path: "P.md", title: "Project", type: "research-project", project: "P.md", question: "Does it work?", audience: "Researchers", stage: "reason", status: "active" },
    { path: "S1.md", title: "Trial", type: "research-source", project: "P.md", sourceKind: "pdf", capturedContent: "unrelated vault note", contentFingerprint: "sha256:s1" },
    { path: "S2.md", title: "Review", type: "research-source", project: "P.md", sourceKind: "doi", contentFingerprint: "sha256:s2" },
    { path: "E1.md", title: "Support", type: "evidence", project: "P.md", source: "S1.md", locatorKind: "page", locatorValue: "4", excerpt: "Improved outcomes", interpretation: "Positive result", reviewState: "reviewed", sourceFingerprint: "sha256:s1" },
    { path: "E2.md", title: "Challenge", type: "evidence", project: "P.md", source: "S2.md", locatorKind: "section", locatorValue: "Results", excerpt: "No effect", interpretation: "Null result", reviewState: "reviewed", sourceFingerprint: "sha256:s2" },
    { path: "C.md", title: "Claim", type: "claim", project: "P.md", proposition: "Treatment works", confidence: "moderate", reviewState: "reviewed", supports: ["E1.md"], challenges: ["E2.md"], contextualizes: [], limitations: [] },
  ];
  return buildProjectSnapshot("P.md", records, []);
}

function makeFindings(): IntelligenceFinding[] {
  return [{
    id: "contradiction:trusted-support-and-challenge:C.md|E1.md|E2.md",
    category: "contradiction",
    severity: "warning",
    confidence: "high",
    epistemicStatus: "observation",
    title: "Claim has supporting and challenging evidence",
    rationale: "Reviewed evidence appears on both sides.",
    paths: ["E2.md", "C.md", "E1.md"],
    verification: "Review the cited records.",
  }];
}

describe("research intelligence narrative trust boundary", () => {
  it("fingerprints equivalent snapshots independent of record ordering", () => {
    const left = makeSnapshot();
    const right = { ...left, sources: [...left.sources].reverse(), evidence: [...left.evidence].reverse() };
    expect(fingerprintIntelligenceSnapshot(left)).toBe(fingerprintIntelligenceSnapshot(right));
  });

  it("changes when a narrative-relevant field changes", () => {
    const left = makeSnapshot();
    const right = { ...left, claims: left.claims.map((claim) => ({ ...claim, proposition: `${claim.proposition} revised` })) };
    expect(fingerprintIntelligenceSnapshot(left)).not.toBe(fingerprintIntelligenceSnapshot(right));
  });

  it("fingerprints parse issues independent of issue ordering", () => {
    const base = makeSnapshot();
    const issues = [
      { path: "Broken.md", code: "missing-field" as const, message: "Missing required field: title" },
      { path: "Other.md", code: "invalid-value" as const, message: "stage must be one of: frame, collect, reason, draft" },
    ];
    const reordered = { ...base, issues: [...issues].reverse() };
    const changed = { ...base, issues: [{ ...issues[0]!, message: "Missing required field: project" }, issues[1]!] };

    expect(fingerprintIntelligenceSnapshot({ ...base, issues })).toBe(fingerprintIntelligenceSnapshot(reordered));
    expect(fingerprintIntelligenceSnapshot({ ...base, issues })).not.toBe(fingerprintIntelligenceSnapshot(changed));
  });

  it("sends only allowed paths and bounded captured context", () => {
    const request = buildNarrativeRequest(makeSnapshot(), makeFindings());
    expect(request.allowedPaths).toEqual([...request.allowedPaths].sort());
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.content).toContain("E1.md");
    expect(request.messages[0]?.content).not.toContain("unrelated vault note");
  });

  it("clips each narrative evidence context field at exactly 1,000 characters", () => {
    const base = makeSnapshot();
    const longExcerpt = "x".repeat(1_000) + "EXTRA";
    const longInterpretation = "y".repeat(1_000) + "EXTRA";
    const changed = { ...base, evidence: base.evidence.map((item) => item.path === "E1.md" ? { ...item, excerpt: longExcerpt, interpretation: longInterpretation } : item) };
    const request = buildNarrativeRequest(changed, makeFindings());
    const payload = JSON.parse(String(request.messages[0]?.content)) as { records: Array<{ path: string; excerpt?: string; interpretation?: string }> };
    const record = payload.records.find(({ path }) => path === "E1.md");
    expect(record?.excerpt).toHaveLength(1_000);
    expect(record?.interpretation).toHaveLength(1_000);
    expect(record?.excerpt).toBe("x".repeat(1_000));
    expect(record?.interpretation).toBe("y".repeat(1_000));
  });

  it.each([
    ["project path", { projectPath: "Other.md" }],
    ["snapshot fingerprint", { snapshotFingerprint: "v1:changed" }],
    ["narrator mode", { narratorMode: "local" as const }],
    ["provider", { providerId: "ollama" as const }],
    ["model", { model: "other-model" }],
  ])("changes the narrative cache key when %s changes", (_label, change) => {
    const base = { projectPath: "P.md", snapshotFingerprint: "v1:base", narratorMode: "current" as const, providerId: "anthropic" as const, model: "claude-test" };
    expect(buildNarrativeCacheKey(base)).not.toBe(buildNarrativeCacheKey({ ...base, ...change }));
  });

  it("builds the same request for reversed findings with duplicate ids", () => {
    const first = makeFindings()[0]!;
    const second = { ...first, title: "A second interpretation", rationale: "Different content under the same id." };

    expect(buildNarrativeRequest(makeSnapshot(), [first, second])).toEqual(
      buildNarrativeRequest(makeSnapshot(), [second, first]),
    );
  });

  it("accepts structured insights with allowed citations", () => {
    const result = parseNarrativeResponse(JSON.stringify({
      briefing: "Two priorities.",
      groups: [{ title: "Resolve tension", insights: [{
        text: "The claim has reviewed evidence on both sides.",
        epistemicStatus: "observation",
        paths: ["C.md", "E1.md", "E2.md"],
      }] }],
    }), new Set(["C.md", "E1.md", "E2.md"]));
    expect(result.groups[0]?.insights).toHaveLength(1);
  });

  it("discards unknown citations and rejects a wholly unusable response", () => {
    expect(() => parseNarrativeResponse(JSON.stringify({
      briefing: "Unsafe",
      groups: [{ title: "Invented", insights: [{ text: "Outside claim", epistemicStatus: "observation", paths: ["Outside.md"] }] }],
    }), new Set(["C.md"]))).toThrow(/verified|allowed path/i);
  });

  it("discards an entire insight when any citation is unknown", () => {
    const mixedInsight = {
      text: "This mixes project evidence with an outside citation.",
      epistemicStatus: "observation",
      paths: ["C.md", "Outside.md"],
    };
    const validInsight = {
      text: "This is supported by project evidence.",
      epistemicStatus: "inference",
      paths: ["C.md"],
    };

    const result = parseNarrativeResponse(JSON.stringify({
      briefing: "Only verified insights survive.",
      groups: [{ title: "Trust boundary", insights: [mixedInsight, validInsight] }],
    }), new Set(["C.md"]));

    expect(result.groups[0]?.insights).toEqual([validInsight]);
    expect(() => parseNarrativeResponse(JSON.stringify({
      briefing: "No verified insight.",
      groups: [{ title: "Trust boundary", insights: [mixedInsight] }],
    }), new Set(["C.md"]))).toThrow(/verified|allowed path/i);
  });

  it.each([
    ["empty path list", []],
    ["empty path", ["C.md", ""]],
    ["non-string path", ["C.md", 42]],
  ])("rejects an insight with an invalid %s", (_label, paths) => {
    expect(() => parseNarrativeResponse(JSON.stringify({
      briefing: "Malformed citations.",
      groups: [{ title: "Trust boundary", insights: [{ text: "Malformed", epistemicStatus: "observation", paths }] }],
    }), new Set(["C.md"]))).toThrow(/verified|allowed path/i);
  });

  it("rejects free-form prose and unsupported epistemic labels", () => {
    expect(() => parseNarrativeResponse("ordinary prose", new Set(["C.md"]))).toThrow(/JSON/i);
    expect(() => parseNarrativeResponse(JSON.stringify({ briefing: "x", groups: [{ title: "x", insights: [{ text: "x", epistemicStatus: "fact", paths: ["C.md"] }] }] }), new Set(["C.md"]))).toThrow(/verified|schema/i);
  });
});
