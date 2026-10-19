import { describe, expect, it } from "vitest";
import { auditProject, type AuditFinding } from "../../src/research/audit";
import { buildProjectSnapshot, isTrustedEvidence } from "../../src/research/graph";
import { buildArgument } from "../../src/research/argument";
import { nextSteps } from "../../src/research/nextSteps";
import type { ParseIssue } from "../../src/research/parse";
import type { ResearchRecord } from "../../src/research/types";

function project(records: ResearchRecord[], issues: ParseIssue[] = []) {
  const root: ResearchRecord = { path: "Projects/P.md", title: "P", type: "research-project", project: "Projects/P.md", question: "Why?", stage: "reason", status: "active" };
  return buildProjectSnapshot("Projects/P.md", [root, ...records], issues);
}

describe("auditProject", () => {
  const source: ResearchRecord = { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P.md", sourceKind: "vault" };
  const unlocated: ResearchRecord = { path: "Evidence/E.md", title: "E", type: "evidence", project: "Projects/P.md", source: source.path, excerpt: "X", reviewState: "proposed" };
  const missingLocator: ParseIssue = { path: unlocated.path, code: "missing-locator", message: "Evidence should identify both locator_kind and locator_value" };

  it.each(["proposed", "reviewed"] as const)("guides a readable %s unlocated passage to review without calling its properties unreadable", (reviewState) => {
    const snapshot = project([source, { ...unlocated, reviewState }], [missingLocator]);
    const findings = auditProject(snapshot);
    expect(findings.filter(({ code }) => code === "missing-locator")).toEqual([expect.objectContaining({ path: unlocated.path, severity: "warning" })]);
    expect(findings.some(({ code }) => code === "invalid-record")).toBe(false);
    expect(buildArgument(snapshot, findings, []).fixFirst).toEqual([]);
    expect(nextSteps({ snapshot, audit: findings, webSearch: false })[0]).toMatchObject({ kind: "check", path: unlocated.path });
    expect(isTrustedEvidence(snapshot.evidence[0], snapshot.sources[0])).toBe(false);
    expect(snapshot.issues).toEqual([missingLocator]);
  });

  it.each(["missing-field", "invalid-value"] as const)("retains a structural %s issue on a readable passage", (code) => {
    const findings = auditProject(project([source, unlocated], [missingLocator, { path: unlocated.path, code, message: "Invalid field" }]));
    expect(findings.filter(({ code }) => code === "invalid-record")).toEqual([expect.objectContaining({ severity: "error", explanation: `${code}: Invalid field` })]);
    expect(findings.filter(({ code }) => code === "missing-locator")).toHaveLength(1);
  });

  it("keeps repair findings when the passage could not be parsed", () => {
    expect(auditProject(project([source], [missingLocator]))).toEqual([expect.objectContaining({ code: "invalid-record", path: unlocated.path, severity: "error" })]);
  });

  it("explains unreviewed, unsupported, and unused records in stable order", () => {
    const findings = auditProject(project([
      { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P.md", sourceKind: "pdf" },
      { path: "Evidence/E.md", title: "E", type: "evidence", project: "Projects/P.md", source: "Sources/S.md", locatorKind: "page", locatorValue: "2", excerpt: "X", reviewState: "proposed" },
      { path: "Claims/C.md", title: "C", type: "claim", project: "Projects/P.md", proposition: "X", confidence: "low", reviewState: "proposed", supports: [], challenges: [], contextualizes: [], limitations: [] },
    ]));
    expect(findings.map(({ code }) => code)).toEqual(["unsupported-claim", "unreviewed-claim", "unreviewed-evidence", "unused-evidence"]);
    expect(findings.every(({ explanation, repair }) => explanation.length > 0 && repair.length > 0)).toBe(true);
  });

  it("explains rejected claims separately from unreviewed claims", () => {
    const findings = auditProject(project([
      { path: "Claims/R.md", title: "R", type: "claim", project: "Projects/P.md", proposition: "Do not trust", confidence: "low", reviewState: "rejected", supports: [], challenges: [], contextualizes: [], limitations: [] },
    ]));
    expect(findings.map(({ code }) => code)).toEqual(["rejected-claim", "unsupported-claim"]);
    expect(findings[0]?.repair).toMatch(/remove.*outline|review/i);
  });

  it("treats challenging-only claims as unsupported", () => {
    const findings = auditProject(project([
      { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P.md", sourceKind: "web" },
      { path: "Evidence/E.md", title: "E", type: "evidence", project: "Projects/P.md", source: "Sources/S.md", locatorKind: "section", locatorValue: "Results", excerpt: "X", reviewState: "reviewed" },
      { path: "Claims/C.md", title: "C", type: "claim", project: "Projects/P.md", proposition: "X", confidence: "low", reviewState: "proposed", supports: [], challenges: ["Evidence/E.md"], contextualizes: [], limitations: [] },
    ]));
    expect(findings.map(({ code }) => code)).toContain("unsupported-claim");
    expect(findings.map(({ code }) => code)).not.toContain("unused-evidence");
  });

  it("reports missing sources, locators, and stale captures", () => {
    const findings = auditProject(project([
      { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P.md", sourceKind: "web", contentFingerprint: "new" },
      { path: "Evidence/Missing.md", title: "Missing", type: "evidence", project: "Projects/P.md", source: "Sources/Nope.md", excerpt: "X", reviewState: "reviewed" },
      { path: "Evidence/Stale.md", title: "Stale", type: "evidence", project: "Projects/P.md", source: "Sources/S.md", locatorKind: "paragraph", locatorValue: "3", excerpt: "Y", reviewState: "reviewed", sourceFingerprint: "old" },
      { path: "Claims/C.md", title: "C", type: "claim", project: "Projects/P.md", proposition: "X", confidence: "low", reviewState: "proposed", supports: ["Evidence/Stale.md"], challenges: [], contextualizes: [], limitations: [] },
    ]));
    expect(findings.map(({ code }) => code)).toEqual(expect.arrayContaining(["broken-reference", "missing-locator", "stale-evidence", "unsupported-claim"]));
  });

  it("audits question targets within the project", () => {
    const question: ResearchRecord = { path: "Questions/Q.md", title: "Q", type: "research-question", project: "Projects/P.md", question: "What?", status: "open", about: "Claims/Elsewhere.md" };
    const expected: AuditFinding[] = [{
      code: "broken-reference",
      severity: "error",
      path: "Questions/Q.md",
      explanation: "Question references missing or out-of-project target Claims/Elsewhere.md.",
      repair: "Link the question to a record in this research project or remove the broken reference.",
    }];
    expect(auditProject(project([question]))).toEqual(expected);
    expect(auditProject(project([
      question,
      { path: "Claims/Elsewhere.md", title: "Elsewhere", type: "claim", project: "Projects/Other.md", proposition: "X", confidence: "low", reviewState: "reviewed", supports: [], challenges: [], contextualizes: [], limitations: [] },
    ]))).toEqual(expected);
  });

  it("uses locale-independent code-unit ordering and is invariant to record order", () => {
    const items: ResearchRecord[] = [
      { path: "Evidence/ä.md", title: "Umlaut", type: "evidence", project: "Projects/P.md", source: "Missing.md", excerpt: "X", reviewState: "reviewed" },
      { path: "Evidence/z.md", title: "Z", type: "evidence", project: "Projects/P.md", source: "Missing.md", excerpt: "Y", reviewState: "reviewed" },
    ];
    const forward = auditProject(project(items));
    const reverse = auditProject(project([...items].reverse()));
    expect(forward).toEqual(reverse);
    expect(forward.filter(({ code }) => code === "broken-reference").map(({ path }) => path)).toEqual(["Evidence/z.md", "Evidence/ä.md"]);
  });
});
