import type { ProjectSnapshot } from "./graph";
import type { SectionState } from "./sectionStatus";
import type { ResearchProjectRecord } from "./types";

export function deriveResearchStage(snapshot: ProjectSnapshot, sections?: readonly SectionState[]): ResearchProjectRecord["stage"] {
  if (!snapshot.project.question.trim()) return "frame";
  if (!snapshot.sources.length) return "gather";
  if (!snapshot.evidence.length) return "read";
  if (!snapshot.claims.length) return "reason";
  if (!snapshot.documents.length) return "shape";
  if (!sections?.length || sections.some((state) => state !== "drafted")) return "write";
  return "assure";
}
