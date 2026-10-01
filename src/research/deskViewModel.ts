import type { AuditFinding } from "./audit";
import { compareCodeUnits, type ProjectSnapshot } from "./graph";
import { challengedClaimCopy, findingCopy } from "./findingCopy";
import { researchContinuationStep, recordBasename as basename } from "./nextStep";
import type { ResearchProjectRecord } from "./types";

export const RESEARCH_STAGES = ["frame", "gather", "read", "reason", "shape", "write", "assure"] as const;
export type ResearchDeskTarget = "Overview" | "Sources" | "Evidence" | "Claims" | "Outline" | "Draft" | "Audit" | "Intelligence" | "Discover";

export interface ResearchDeskPreferences {
  dismissedActionIds: string[];
  pinnedActionId?: string;
}

export type ResearchDeskRun = "add-source" | "extract-evidence" | "review-evidence" | "review-claim" | "create-claim" | "build-outline" | "continue-draft" | "audit" | "open-record";

export interface ResearchDeskAction {
  id: string;
  label: string;
  reason: string;
  target: ResearchDeskTarget;
  run: ResearchDeskRun;
  priority: number;
  path?: string;
  tone: "blocked" | "attention" | "continue" | "assure";
  pinned?: boolean;
}

export interface ResearchDeskDocumentProgress {
  path: string;
  title: string;
  completedSections: number;
  totalSections: number;
}

export interface ResearchDeskViewModel {
  title: string;
  question: string;
  stage: {
    current: ResearchProjectRecord["stage"];
    index: number;
    total: number;
    steps: Array<{ id: ResearchProjectRecord["stage"]; label: string; state: "complete" | "current" | "upcoming" }>;
  };
  counts: { sources: number; evidence: number; claims: number; openQuestions: number };
  actions: ResearchDeskAction[];
  nextAction?: ResearchDeskAction;
  attention: ResearchDeskAction[];
  activeDocument?: ResearchDeskDocumentProgress & { progress: number };
}

function title(value: string): string { return value[0]?.toUpperCase() + value.slice(1); }

export function findingAction(finding: AuditFinding): ResearchDeskAction | undefined {
  const name = basename(finding.path);
  const copy = findingCopy(finding.code, name);
  const base = { ...copy, path: finding.path };
  switch (finding.code) {
    case "unused-evidence": return undefined;
    case "unverifiable-source": return { id: `unverifiable-source:${finding.path}`, ...base, target: "Audit", run: "open-record", priority: 0, tone: "blocked" };
    case "stale-evidence": return { id: `stale-evidence:${finding.path}`, ...base, target: "Evidence", run: "review-evidence", priority: 0, tone: "blocked" };
    case "broken-reference":
    case "invalid-record": return { id: `${finding.code}:${finding.path}`, ...base, target: "Audit", run: "open-record", priority: 0, tone: "blocked" };
    case "rejected-claim": return { id: `rejected-claim:${finding.path}`, ...base, target: "Claims", run: "review-claim", priority: 1, tone: "blocked" };
    case "unsupported-claim": return { id: `unsupported-claim:${finding.path}`, ...base, target: "Claims", run: "review-claim", priority: 1, tone: "blocked" };
    case "missing-locator": return { id: `missing-locator:${finding.path}`, ...base, target: "Evidence", run: "review-evidence", priority: 2, tone: "attention" };
    case "unreviewed-claim": return { id: `review-claim:${finding.path}`, ...base, target: "Claims", run: "review-claim", priority: 2, tone: "attention" };
    case "unreviewed-evidence": return { id: `review-evidence:${finding.path}`, ...base, target: "Evidence", run: "review-evidence", priority: 3, tone: "attention" };
  }
}

function continuationActions(snapshot: ProjectSnapshot): ResearchDeskAction[] {
  const { step, path } = researchContinuationStep(snapshot);
  switch (step) {
    case "add-source":
      return [{ id: `add-source:${path}`, label: "Capture the first source", reason: "A project needs source material before evidence and claims can be developed.", target: "Sources", run: "add-source", priority: 4, path, tone: "continue" }];
    case "create-evidence":
      return [{ id: `create-evidence:${path}`, label: "Extract the first evidence", reason: "Turn a precise source passage into reviewable evidence.", target: "Evidence", run: "extract-evidence", priority: 4, path, tone: "continue" }];
    case "create-claim":
      return [{ id: `create-claim:${path}`, label: "Develop the first claim", reason: "Connect reviewed evidence to a proposition the document can use.", target: "Claims", run: "create-claim", priority: 4, path, tone: "continue" }];
    case "build-outline":
      return [{ id: `build-outline:${path}`, label: "Build the evidence-backed outline", reason: "The reviewed claims are ready to become a document structure.", target: "Outline", run: "build-outline", priority: 6, path, tone: "continue" }];
    case "continue-outline":
      return [{ id: `continue-outline:${path}`, label: "Continue into the draft", reason: "The outline is ready for claim-grounded section drafting.", target: "Draft", run: "continue-draft", priority: 6, path, tone: "continue" }];
    case "assure-document":
      return [{ id: `assure-document:${path}`, label: "Assure the current draft", reason: "Audit the document for grounding, evidence drift, and unresolved research gaps.", target: "Audit", run: "audit", priority: 8, path, tone: "assure" }];
  }
}

export function buildResearchDeskViewModel(snapshot: ProjectSnapshot, findings: AuditFinding[], preferences: ResearchDeskPreferences, document?: ResearchDeskDocumentProgress): ResearchDeskViewModel {
  const actions = findings.map(findingAction).filter((action): action is ResearchDeskAction => Boolean(action));
  for (const claim of snapshot.claims) if (claim.challenging.length && !claim.limitations.length) actions.push({ id: `challenged-claim:${claim.path}`, ...challengedClaimCopy(claim.title, claim.challenging.length), target: "Claims", run: "review-claim", priority: 1, path: claim.path, tone: "attention" });
  for (const question of snapshot.questions) if (question.status === "open") actions.push({ id: `open-question:${question.path}`, label: question.title, reason: question.question, target: "Overview", run: "open-record", priority: 5, path: question.path, tone: "attention" });
  actions.push(...continuationActions(snapshot));
  actions.sort((left, right) => left.priority - right.priority || compareCodeUnits(left.path ?? "", right.path ?? "") || compareCodeUnits(left.id, right.id));

  const dismissed = new Set(preferences.dismissedActionIds);
  const visible = actions.filter(({ id }) => !dismissed.has(id) || id === preferences.pinnedActionId);
  const pinnedIndex = preferences.pinnedActionId ? visible.findIndex(({ id }) => id === preferences.pinnedActionId) : -1;
  if (pinnedIndex > 0) visible.unshift(visible.splice(pinnedIndex, 1)[0]!);
  if (visible[0] && visible[0].id === preferences.pinnedActionId) visible[0] = { ...visible[0], pinned: true };

  const stageIndex = RESEARCH_STAGES.indexOf(snapshot.project.stage);
  const activeDocument = document ? { ...document, progress: document.totalSections ? Math.round((document.completedSections / document.totalSections) * 100) : 0 } : undefined;
  return {
    title: snapshot.project.title,
    question: snapshot.project.question,
    stage: { current: snapshot.project.stage, index: stageIndex, total: RESEARCH_STAGES.length, steps: RESEARCH_STAGES.map((id, index) => ({ id, label: title(id), state: index < stageIndex ? "complete" : index === stageIndex ? "current" : "upcoming" })) },
    counts: { sources: snapshot.sources.length, evidence: snapshot.evidence.length, claims: snapshot.claims.length, openQuestions: snapshot.questions.filter(({ status }) => status === "open").length },
    actions: visible,
    ...(visible[0] ? { nextAction: visible[0] } : {}),
    attention: visible.filter(({ tone }) => tone === "blocked" || tone === "attention").slice(0, 6),
    ...(activeDocument ? { activeDocument } : {}),
  };
}
