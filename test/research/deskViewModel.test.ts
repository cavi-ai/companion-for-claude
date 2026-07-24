import { describe, expect, it } from "vitest";
import { auditProject } from "../../src/research/audit";
import { buildResearchDeskViewModel } from "../../src/research/deskViewModel";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";

const project = { path: "Research/P/Project.md", title: "Continuity", type: "research-project", project: "Research/P/Project.md", question: "How does continuity survive?", stage: "write", status: "active" } as const;

function snapshot(records: ResearchRecord[] = []) {
  return buildProjectSnapshot(project.path, [project, ...records], []);
}

const source: ResearchRecord = { path: "Research/P/Sources/S.md", title: "Study", type: "research-source", project: project.path, sourceKind: "web", contentFingerprint: "sha256:new" };
const staleEvidence: ResearchRecord = { path: "Research/P/Evidence/Stale.md", title: "Stale result", type: "evidence", project: project.path, source: source.path, sourceFingerprint: "sha256:old", locatorKind: "page", locatorValue: "4", excerpt: "Result", reviewState: "reviewed" };
const proposedEvidence: ResearchRecord = { path: "Research/P/Evidence/Proposed.md", title: "Proposed result", type: "evidence", project: project.path, source: source.path, locatorKind: "page", locatorValue: "8", excerpt: "Result", reviewState: "proposed" };
const challengedClaim: ResearchRecord = { path: "Research/P/Claims/C.md", title: "Continuity claim", type: "claim", project: project.path, proposition: "Continuity survives.", confidence: "moderate", reviewState: "reviewed", supports: [staleEvidence.path], challenges: [proposedEvidence.path], contextualizes: [], limitations: [] };
const question: ResearchRecord = { path: "Research/P/Questions/Q.md", title: "Mechanism", type: "research-question", project: project.path, question: "Which mechanism matters?", status: "open", about: challengedClaim.path };
const draft: ResearchRecord = { path: "Research/P/Documents/Draft.md", title: "White paper", type: "research-document", project: project.path, documentKind: "draft", claims: [challengedClaim.path] };

describe("buildResearchDeskViewModel", () => {
  it("makes stale grounding the explainable next action before lower-priority work", () => {
    const current = snapshot([source, staleEvidence, proposedEvidence, challengedClaim, question, draft]);
    const vm = buildResearchDeskViewModel(current, auditProject(current), { dismissedActionIds: [] }, { path: draft.path, title: draft.title, completedSections: 2, totalSections: 4 });
    expect(vm.nextAction).toMatchObject({ id: `stale-evidence:${staleEvidence.path}`, target: "Evidence", path: staleEvidence.path });
    expect(vm.nextAction?.reason).toMatch(/changed after this evidence was reviewed/i);
    expect(vm.attention.map(({ id }) => id)).toContain(`open-question:${question.path}`);
    expect(new Set(vm.attention.map(({ label }) => label)).size).toBe(vm.attention.length);
  });

  it("respects dismissed and pinned actions without hiding the remaining queue", () => {
    const current = snapshot([source, staleEvidence, proposedEvidence, challengedClaim, question, draft]);
    const findings = auditProject(current);
    const base = buildResearchDeskViewModel(current, findings, { dismissedActionIds: [] });
    const review = base.actions.find(({ id }) => id === `review-evidence:${proposedEvidence.path}`);
    if (!review) throw new Error("missing review action");
    const dismissed = buildResearchDeskViewModel(current, findings, { dismissedActionIds: [base.nextAction!.id] });
    expect(dismissed.nextAction?.id).not.toBe(base.nextAction?.id);
    const pinned = buildResearchDeskViewModel(current, findings, { dismissedActionIds: [base.nextAction!.id], pinnedActionId: review.id });
    expect(pinned.nextAction).toMatchObject({ id: review.id, pinned: true });
    expect(pinned.actions.length).toBeGreaterThan(1);
  });

  it("summarizes stage-aware progress and active-document continuity", () => {
    const current = snapshot([source, staleEvidence, challengedClaim, draft]);
    const vm = buildResearchDeskViewModel(current, auditProject(current), { dismissedActionIds: [] }, { path: draft.path, title: draft.title, completedSections: 3, totalSections: 5 });
    expect(vm.stage).toMatchObject({ current: "write", index: 5, total: 7 });
    expect(vm.stage.steps.map(({ state }) => state)).toEqual(["complete", "complete", "complete", "complete", "complete", "current", "upcoming"]);
    expect(vm.activeDocument).toMatchObject({ title: "White paper", completedSections: 3, totalSections: 5, progress: 60 });
  });

  it("guides a new project through source, evidence, claim, outline, and assurance prerequisites", () => {
    expect(buildResearchDeskViewModel(snapshot(), [], { dismissedActionIds: [] }).nextAction).toMatchObject({ id: `add-source:${project.path}`, target: "Sources" });
    const withSource = snapshot([source]);
    expect(buildResearchDeskViewModel(withSource, auditProject(withSource), { dismissedActionIds: [] }).nextAction).toMatchObject({ id: `create-evidence:${source.path}`, target: "Evidence" });
    const reviewedEvidence = { ...proposedEvidence, reviewState: "reviewed" as const };
    const withEvidence = snapshot([source, reviewedEvidence]);
    expect(buildResearchDeskViewModel(withEvidence, auditProject(withEvidence), { dismissedActionIds: [] }).nextAction).toMatchObject({ id: `create-claim:${project.path}`, target: "Claims" });
  });
});
