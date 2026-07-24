import type { AuditFinding } from "./audit";
import { compareCodeUnits, type ProjectSnapshot } from "./graph";
import type { ResearchProjectRecord } from "./types";

export const RESEARCH_STAGES = ["frame", "gather", "read", "reason", "shape", "write", "assure"] as const;
export type ResearchDeskTarget = "Overview" | "Sources" | "Evidence" | "Claims" | "Outline" | "Draft" | "Audit" | "Intelligence" | "Discover";

export interface ResearchDeskPreferences {
  dismissedActionIds: string[];
  pinnedActionId?: string;
}

export interface ResearchDeskAction {
  id: string;
  label: string;
  reason: string;
  target: ResearchDeskTarget;
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
function basename(path: string): string { return (path.split("/").pop() ?? path).replace(/\.md$/i, ""); }

function findingAction(finding: AuditFinding): ResearchDeskAction | undefined {
  const name = basename(finding.path);
  if (finding.code === "unused-evidence") return undefined;
  if (finding.code === "stale-evidence") return { id: `stale-evidence:${finding.path}`, label: `Re-check ${name}`, reason: "The source changed after this evidence was reviewed.", target: "Evidence", priority: 0, path: finding.path, tone: "blocked" };
  if (finding.code === "broken-reference" || finding.code === "invalid-record") return { id: `${finding.code}:${finding.path}`, label: `Repair ${name}`, reason: finding.explanation, target: "Audit", priority: 0, path: finding.path, tone: "blocked" };
  if (finding.code === "rejected-claim") return { id: `rejected-claim:${finding.path}`, label: `Rework ${name}`, reason: finding.explanation, target: "Claims", priority: 1, path: finding.path, tone: "blocked" };
  if (finding.code === "unsupported-claim") return { id: `unsupported-claim:${finding.path}`, label: `Review support for ${name}`, reason: finding.explanation, target: "Claims", priority: 1, path: finding.path, tone: "blocked" };
  if (finding.code === "missing-locator") return { id: `missing-locator:${finding.path}`, label: `Locate ${name}`, reason: finding.explanation, target: "Evidence", priority: 2, path: finding.path, tone: "attention" };
  if (finding.code === "unreviewed-claim") return { id: `review-claim:${finding.path}`, label: `Review ${name}`, reason: finding.explanation, target: "Claims", priority: 2, path: finding.path, tone: "attention" };
  if (finding.code === "unreviewed-evidence") return { id: `review-evidence:${finding.path}`, label: `Review ${name}`, reason: finding.explanation, target: "Evidence", priority: 3, path: finding.path, tone: "attention" };
  return undefined;
}

function continuationActions(snapshot: ProjectSnapshot): ResearchDeskAction[] {
  if (!snapshot.sources.length) return [{ id: `add-source:${snapshot.project.path}`, label: "Capture the first source", reason: "A project needs source material before evidence and claims can be developed.", target: "Sources", priority: 4, path: snapshot.project.path, tone: "continue" }];
  if (!snapshot.evidence.length) return [{ id: `create-evidence:${snapshot.sources[0]!.path}`, label: "Extract the first evidence", reason: "Turn a precise source passage into reviewable evidence.", target: "Evidence", priority: 4, path: snapshot.sources[0]!.path, tone: "continue" }];
  if (!snapshot.claims.length) return [{ id: `create-claim:${snapshot.project.path}`, label: "Develop the first claim", reason: "Connect reviewed evidence to a proposition the document can use.", target: "Claims", priority: 4, path: snapshot.project.path, tone: "continue" }];
  if (!snapshot.documents.length) return [{ id: `build-outline:${snapshot.project.path}`, label: "Build the evidence-backed outline", reason: "The reviewed claims are ready to become a document structure.", target: "Outline", priority: 6, path: snapshot.project.path, tone: "continue" }];
  const draft = snapshot.documents.find(({ documentKind }) => documentKind === "draft");
  if (!draft) return [{ id: `continue-outline:${snapshot.documents[0]!.path}`, label: "Continue into the draft", reason: "The outline is ready for claim-grounded section drafting.", target: "Draft", priority: 6, path: snapshot.documents[0]!.path, tone: "continue" }];
  return [{ id: `assure-document:${draft.path}`, label: "Assure the current draft", reason: "Audit the document for grounding, evidence drift, and unresolved research gaps.", target: "Audit", priority: 8, path: draft.path, tone: "assure" }];
}

export function buildResearchDeskViewModel(snapshot: ProjectSnapshot, findings: AuditFinding[], preferences: ResearchDeskPreferences, document?: ResearchDeskDocumentProgress): ResearchDeskViewModel {
  const actions = findings.map(findingAction).filter((action): action is ResearchDeskAction => Boolean(action));
  for (const claim of snapshot.claims) if (claim.challenging.length) actions.push({ id: `challenged-claim:${claim.path}`, label: `Respond to challenges for ${claim.title}`, reason: `${claim.challenging.length} challenging evidence record${claim.challenging.length === 1 ? "" : "s"} need an explicit response.`, target: "Claims", priority: 1, path: claim.path, tone: "attention" });
  for (const question of snapshot.questions) if (question.status === "open") actions.push({ id: `open-question:${question.path}`, label: question.title, reason: question.question, target: "Overview", priority: 5, path: question.path, tone: "attention" });
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
