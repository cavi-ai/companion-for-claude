import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { analyzeProjectIntelligence } from "../../src/research/intelligence";
import type { ResearchRecord } from "../../src/research/types";

function snapshot(overrides: ResearchRecord[] = []) {
  const records: ResearchRecord[] = [
    { path: "P.md", title: "P", type: "research-project", project: "P.md", question: "Q?", stage: "reason", status: "active" },
    { path: "S1.md", title: "Trial", type: "research-source", project: "P.md", sourceKind: "pdf", published: "2024", contentFingerprint: "sha256:s1" },
    { path: "S2.md", title: "Review", type: "research-source", project: "P.md", sourceKind: "doi", published: "2018", contentFingerprint: "sha256:s2" },
    { path: "E1.md", title: "Support", type: "evidence", project: "P.md", source: "S1.md", locatorKind: "page", locatorValue: "4", excerpt: "Improved", interpretation: "Positive result", reviewState: "reviewed", sourceFingerprint: "sha256:s1" },
    { path: "E2.md", title: "Challenge", type: "evidence", project: "P.md", source: "S2.md", locatorKind: "section", locatorValue: "Results", excerpt: "No effect", interpretation: "Null result", reviewState: "reviewed", sourceFingerprint: "sha256:s2" },
    { path: "C.md", title: "Claim", type: "claim", project: "P.md", proposition: "Treatment works", confidence: "moderate", reviewState: "reviewed", supports: ["E1.md"], challenges: ["E2.md"], contextualizes: [], limitations: [] },
    ...overrides,
  ];
  return buildProjectSnapshot("P.md", records, []);
}

describe("analyzeProjectIntelligence", () => {
  it("reports a contradiction candidate without deciding which evidence wins", () => {
    const findings = analyzeProjectIntelligence(snapshot());
    expect(findings).toContainEqual(expect.objectContaining({
      category: "contradiction",
      epistemicStatus: "observation",
      paths: ["C.md", "E1.md", "E2.md"],
    }));
    expect(findings.find(({ category }) => category === "contradiction")?.rationale).toMatch(/supporting and challenging evidence/i);
    expect(JSON.stringify(findings)).not.toMatch(/disproves|false/i);
  });

  it("reports only captured methodological fields", () => {
    const finding = analyzeProjectIntelligence(snapshot()).find(({ category }) => category === "method-difference");
    expect(finding?.rationale).toMatch(/pdf|doi/i);
    expect(finding?.rationale).not.toMatch(/randomized|population|sample size/i);
  });

  it("does not report contradiction when the challenge is proposed, stale, or missing a locator", () => {
    for (const change of [
      { reviewState: "proposed" as const },
      { sourceFingerprint: "sha256:old" },
      { locatorValue: "" },
    ]) {
      const base = snapshot();
      const changed = { ...base, evidence: base.evidence.map((item) => item.path === "E2.md" ? { ...item, ...change } : item) };
      expect(analyzeProjectIntelligence(changed).some(({ category }) => category === "contradiction")).toBe(false);
    }
  });

  it("surfaces open questions, no counterevidence, unused reviewed evidence, and audit quality", () => {
    const findings = analyzeProjectIntelligence(snapshot([
      { path: "Q1.md", title: "Open", type: "research-question", project: "P.md", question: "Replicate?", status: "open", about: "C.md" },
      { path: "E3.md", title: "Unused", type: "evidence", project: "P.md", source: "S1.md", locatorKind: "page", locatorValue: "9", excerpt: "Other", reviewState: "reviewed", sourceFingerprint: "sha256:s1" },
      { path: "E4.md", title: "Needs review", type: "evidence", project: "P.md", source: "S1.md", locatorKind: "page", locatorValue: "10", excerpt: "Proposed", reviewState: "proposed", sourceFingerprint: "sha256:s1" },
      { path: "C2.md", title: "Unchallenged", type: "claim", project: "P.md", proposition: "A second claim", confidence: "moderate", reviewState: "reviewed", supports: ["E1.md"], challenges: [], contextualizes: [], limitations: [] },
    ]));
    expect(findings.map(({ category }) => category)).toEqual(expect.arrayContaining(["research-gap", "evidence-quality"]));
    expect(findings.some(({ paths }) => paths.includes("Q1.md"))).toBe(true);
    expect(findings.some(({ paths }) => paths.includes("E3.md"))).toBe(true);
    expect(findings.some(({ paths }) => paths.includes("C2.md") && /counterevidence/i.test(findings.find(({ paths }) => paths.includes("C2.md"))?.rationale ?? ""))).toBe(true);
    expect(findings).toContainEqual(expect.objectContaining({ category: "research-gap", paths: ["E3.md"] }));
  });

  it.each(["proposed", "rejected"] as const)("does not map unused %s evidence into a research gap", (reviewState) => {
    const findings = analyzeProjectIntelligence(snapshot([
      { path: "E3.md", title: "Unused", type: "evidence", project: "P.md", source: "S1.md", locatorKind: "page", locatorValue: "9", excerpt: "Other", reviewState, sourceFingerprint: "sha256:s1" },
    ]));
    expect(findings).toContainEqual(expect.objectContaining({ category: "evidence-quality", paths: ["E3.md"] }));
    expect(findings).not.toContainEqual(expect.objectContaining({ category: "research-gap", paths: ["E3.md"] }));
  });

  it("returns identical IDs and ordering for equivalent snapshots", () => {
    const first = analyzeProjectIntelligence(snapshot());
    const second = analyzeProjectIntelligence(snapshot());
    expect(second).toEqual(first);
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
  });
});
