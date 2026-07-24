import { describe, expect, it } from "vitest";
import type { AuditFinding } from "../../src/research/audit";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";
import { buildWorkbenchViewModel } from "../../src/research/viewModel";

const project = { path: "Research/Project.md", title: "Climate policy", type: "research-project", project: "Research/Project.md", question: "What works?", stage: "read", status: "active" } as const;

function snapshot(records: ResearchRecord[] = []) {
  return buildProjectSnapshot(project.path, [project, ...records], []);
}

function finding(code: AuditFinding["code"], path: string): AuditFinding {
  return { code, path, severity: code === "unsupported-claim" ? "error" : "warning", explanation: code, repair: `Repair ${path}` };
}

describe("buildWorkbenchViewModel", () => {
  it("summarizes project counts and health", () => {
    const records: ResearchRecord[] = [
      ...[1, 2, 3, 4].map((n) => ({ path: `Research/Sources/S${n}.md`, title: `S${n}`, type: "research-source" as const, project: project.path, sourceKind: "web" as const })),
      ...Array.from({ length: 12 }, (_, n) => ({ path: `Research/Evidence/E${n}.md`, title: `E${n}`, type: "evidence" as const, project: project.path, source: "Research/Sources/S1.md", excerpt: "Text", locatorKind: "page" as const, locatorValue: "1", reviewState: n < 2 ? "proposed" as const : n === 2 ? "rejected" as const : "reviewed" as const })),
      ...[1, 2, 3].map((n) => ({ path: `Research/Claims/C${n}.md`, title: `C${n}`, type: "claim" as const, project: project.path, proposition: `Claim ${n}`, confidence: "moderate" as const, reviewState: "reviewed" as const, supports: [], challenges: [], contextualizes: [], limitations: [] })),
      ...[1, 2].map((n) => ({ path: `Research/Questions/Q${n}.md`, title: `Q${n}`, type: "research-question" as const, project: project.path, question: `Q${n}?`, status: "open" as const })),
    ];
    const vm = buildWorkbenchViewModel(snapshot(records), [finding("unsupported-claim", "Research/Claims/C2.md"), finding("unreviewed-evidence", "Research/Evidence/E1.md"), finding("unreviewed-evidence", "Research/Evidence/E0.md")]);
    expect(vm.counts).toEqual({ sources: 4, evidence: 12, claims: 3, openQuestions: 2 });
    expect(vm.health.unsupportedClaims).toBe(1);
    expect(vm.health.unreviewedEvidence).toBe(2);
    expect(vm.nextActions[0]).toMatchObject({ kind: "repair", path: "Research/Claims/C2.md" });
  });

  it("returns a useful empty-project state", () => {
    const vm = buildWorkbenchViewModel(snapshot(), []);
    expect(vm.counts).toEqual({ sources: 0, evidence: 0, claims: 0, openQuestions: 0 });
    expect(vm.nextActions).toEqual([{ kind: "continue", label: "Add a source", path: project.path }]);
  });

  it("handles a missing project record", () => {
    const vm = buildWorkbenchViewModel(undefined, []);
    expect(vm.title).toBe("Research workbench");
    expect(vm.stage).toBe("frame");
    expect(vm.nextActions).toEqual([{ kind: "continue", label: "Create a research project" }]);
  });

  it("counts only active proposed evidence as unreviewed", () => {
    const records: ResearchRecord[] = ["proposed", "reviewed", "rejected"].map((reviewState, n) => ({ path: `Research/Evidence/E${n}.md`, title: `E${n}`, type: "evidence", project: project.path, source: "Research/Sources/S.md", excerpt: "Text", reviewState } as ResearchRecord));
    const vm = buildWorkbenchViewModel(snapshot(records), [finding("unreviewed-evidence", "Research/Evidence/E0.md")]);
    expect(vm.health.unreviewedEvidence).toBe(1);
    expect(vm.nextActions).toContainEqual({ kind: "review", label: "Review E0", path: "Research/Evidence/E0.md" });
  });

  it("orders repairs before reviews and continuation, then by path", () => {
    const findings = [finding("unreviewed-evidence", "Research/Evidence/Z.md"), finding("missing-locator", "Research/Evidence/B.md"), finding("broken-reference", "Research/Claims/A.md")];
    expect(buildWorkbenchViewModel(snapshot(), findings).nextActions.map(({ kind, path }) => [kind, path])).toEqual([
      ["repair", "Research/Claims/A.md"], ["repair", "Research/Evidence/B.md"], ["review", "Research/Evidence/Z.md"],
    ]);
  });
});
