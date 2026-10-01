import type { AuditFinding } from "./audit";
import { compareCodeUnits, type ProjectSnapshot } from "./graph";
import { findingAction, type ResearchDeskRun } from "./deskViewModel";
import { researchContinuationStep } from "./nextStep";
import type { ResearchProjectRecord } from "./types";

export interface WorkbenchViewModel {
  title: string;
  question: string;
  stage: ResearchProjectRecord["stage"];
  counts: { sources: number; evidence: number; claims: number; openQuestions: number };
  health: { unsupportedClaims: number; unreviewedEvidence: number; missingLocators: number; brokenReferences: number };
  nextActions: Array<{ kind: "review" | "repair" | "continue"; label: string; path?: string; run?: ResearchDeskRun }>;
}

export function buildWorkbenchViewModel(snapshot: ProjectSnapshot | undefined, findings: AuditFinding[]): WorkbenchViewModel {
  if (!snapshot) {
    return {
      title: "Research workbench", question: "Choose or create a project to begin.", stage: "frame",
      counts: { sources: 0, evidence: 0, claims: 0, openQuestions: 0 },
      health: { unsupportedClaims: 0, unreviewedEvidence: 0, missingLocators: 0, brokenReferences: 0 },
      nextActions: [{ kind: "continue", label: "Create a research project" }],
    };
  }

  const count = (code: AuditFinding["code"]) => findings.filter((finding) => finding.code === code).length;
  const nextActions: WorkbenchViewModel["nextActions"] = findings
    .filter((finding) => finding.code !== "unused-evidence" && finding.code !== "stale-evidence")
    .flatMap((finding) => {
      const action = findingAction(finding);
      return action ? [{ kind: finding.code === "unreviewed-evidence" ? "review" as const : "repair" as const, label: action.label, path: finding.path, run: action.run }] : [];
    })
    .sort((left, right) => (left.kind === "repair" ? 0 : 1) - (right.kind === "repair" ? 0 : 1) || compareCodeUnits(left.path, right.path));

  if (nextActions.length === 0) {
    // The continuation step is decided once, in nextStep.ts — the desk and the
    // workbench can never drift; only the labels are per-surface.
    const { step, path } = researchContinuationStep(snapshot);
    const next = ({
      "add-source": { label: "Add a source", run: "add-source" },
      "create-evidence": { label: "Extract evidence", run: "extract-evidence" },
      "create-claim": { label: "Create a claim", run: "create-claim" },
      "build-outline": { label: "Build the outline", run: "build-outline" },
      "continue-outline": { label: "Continue into the draft", run: "continue-draft" },
      "assure-document": { label: "Assure the draft", run: "audit" },
    } as const)[step];
    nextActions.push({ kind: "continue", ...next, path });
  }

  return {
    title: snapshot.project.title,
    question: snapshot.project.question,
    stage: snapshot.project.stage,
    counts: { sources: snapshot.sources.length, evidence: snapshot.evidence.length, claims: snapshot.claims.length, openQuestions: snapshot.questions.filter(({ status }) => status === "open").length },
    health: { unsupportedClaims: count("unsupported-claim"), unreviewedEvidence: count("unreviewed-evidence"), missingLocators: count("missing-locator"), brokenReferences: count("broken-reference") },
    nextActions,
  };
}
