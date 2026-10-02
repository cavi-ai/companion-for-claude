import { buildDraftGrounding, groundingClaimFingerprint } from "./draftGrounding";
import type { DraftSectionParseResult, ParsedDraftSection } from "./draftSections";
import type { ProjectSnapshot } from "./graph";
import type { ResearchDocumentRecord } from "./types";

export type SectionState = "outline" | "drafted" | "changed";

export interface SectionSummary {
  id: string;
  heading: string;
  claimPath: string;
  state: SectionState;
}

export interface DocumentSections {
  document: ResearchDocumentRecord;
  parsed: DraftSectionParseResult;
  sections: SectionSummary[];
}

export function activeDocument(snapshot: ProjectSnapshot): ResearchDocumentRecord | undefined {
  return snapshot.documents.find(({ documentKind }) => documentKind === "draft") ?? snapshot.documents.find(({ documentKind }) => documentKind === "outline");
}

export function evidenceChanged(snapshot: ProjectSnapshot, section: ParsedDraftSection): boolean {
  try {
    const claimPath = section.envelope.claimPaths[0];
    if (!claimPath) return true;
    const packet = buildDraftGrounding(snapshot, claimPath);
    return groundingClaimFingerprint(packet) !== section.envelope.claimFingerprint
      || JSON.stringify(packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint }))) !== JSON.stringify(section.envelope.evidence);
  } catch { return true; }
}

export function sectionState(snapshot: ProjectSnapshot, section: ParsedDraftSection): SectionState {
  if (section.envelope.provider === "companion") return "outline";
  return section.modifiedSinceReview || evidenceChanged(snapshot, section) ? "changed" : "drafted";
}

export async function documentSections(snapshot: ProjectSnapshot, load: (path: string) => Promise<DraftSectionParseResult>): Promise<DocumentSections | undefined> {
  const document = activeDocument(snapshot);
  if (!document) return undefined;
  let parsed: DraftSectionParseResult;
  try { parsed = await load(document.path); }
  catch (error) { parsed = { format: "none", sections: [], issues: [error instanceof Error ? error.message : "The document sections could not be loaded."] }; }
  return {
    document,
    parsed,
    sections: parsed.sections.map((section) => ({ id: section.envelope.id, heading: section.heading, claimPath: section.envelope.claimPaths[0] ?? "", state: sectionState(snapshot, section) })),
  };
}
