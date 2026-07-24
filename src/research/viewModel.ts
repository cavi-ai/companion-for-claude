import type { AuditFinding } from "./audit";
import { compareCodeUnits, type ProjectSnapshot } from "./graph";
import type { ResearchProjectRecord } from "./types";

export interface WorkbenchViewModel {
  title: string;
  question: string;
  stage: ResearchProjectRecord["stage"];
  counts: { sources: number; evidence: number; claims: number; openQuestions: number };
  health: { unsupportedClaims: number; unreviewedEvidence: number; missingLocators: number; brokenReferences: number };
  nextActions: Array<{ kind: "review" | "repair" | "continue"; label: string; path?: string }>;
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
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
    .map((finding) => ({
      kind: finding.code === "unreviewed-evidence" ? "review" as const : "repair" as const,
      label: `${finding.code === "unreviewed-evidence" ? "Review" : "Repair"} ${basename(finding.path)}`,
      path: finding.path,
    }))
    .sort((left, right) => (left.kind === "repair" ? 0 : 1) - (right.kind === "repair" ? 0 : 1) || compareCodeUnits(left.path, right.path));

  if (nextActions.length === 0) {
    if (snapshot.sources.length === 0) nextActions.push({ kind: "continue", label: "Add a source", path: snapshot.project.path });
    else if (snapshot.evidence.length === 0) nextActions.push({ kind: "continue", label: "Create evidence", path: snapshot.sources[0]!.path });
    else if (snapshot.claims.length === 0) nextActions.push({ kind: "continue", label: "Create a claim", path: snapshot.project.path });
    else nextActions.push({ kind: "continue", label: "Build the outline", path: snapshot.project.path });
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
