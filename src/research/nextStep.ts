// The single decision layer for "what should happen next in this project" —
// which continuation step applies, in canonical order. Both next-action
// surfaces (the Research Desk's rich action list and the workbench's compact
// one) derive from this so the chains can never drift apart; each keeps its
// own labels and tone.

import type { ProjectSnapshot } from "./graph";

export type ResearchNextStep =
  | "add-source"
  | "create-evidence"
  | "create-claim"
  | "build-outline"
  | "continue-outline"
  | "assure-document";

export interface ContinuationDecision {
  step: ResearchNextStep;
  /** The note the step acts on (project, first source, first document, or draft). */
  path: string;
}

/** The next structural step for a project, in pipeline order. */
export function researchContinuationStep(snapshot: ProjectSnapshot): ContinuationDecision {
  if (!snapshot.sources.length) return { step: "add-source", path: snapshot.project.path };
  if (!snapshot.evidence.length) return { step: "create-evidence", path: snapshot.sources[0]!.path };
  if (!snapshot.claims.length) return { step: "create-claim", path: snapshot.project.path };
  if (!snapshot.documents.length) return { step: "build-outline", path: snapshot.project.path };
  const draft = snapshot.documents.find(({ documentKind }) => documentKind === "draft");
  if (!draft) return { step: "continue-outline", path: snapshot.documents[0]!.path };
  return { step: "assure-document", path: draft.path };
}

/** "Folder/Name.md" → "Name" (shared by both view models). */
export function recordBasename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
