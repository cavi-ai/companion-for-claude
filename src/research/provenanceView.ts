import { isOutlineEnvelope, isReviewedClaimFallback, parseProvenanceJson } from "./draftSections";

export interface ProvenanceRow {
  heading: string;
  citations: Array<{ key: string; sourcePath: string; sourceTitle: string }>;
  passages: number;
  status: string;
}

export function provenanceRows(json: string): { rows: ProvenanceRow[]; issues: string[] } {
  const { entries, issues } = parseProvenanceJson(json);
  return {
    issues,
    rows: entries.map((entry) => ({
      heading: entry.heading,
      citations: entry.citations.map(({ key, sourcePath }) => ({ key, sourcePath, sourceTitle: (sourcePath.split("/").pop() ?? sourcePath).replace(/\.md$/i, "") })),
      passages: entry.evidence.length,
      status: isOutlineEnvelope(entry) ? "Outline" : isReviewedClaimFallback(entry) ? `Companion fallback · ${entry.generatedAt.slice(0, 10)}` : `Drafted · ${entry.model} · ${entry.generatedAt.slice(0, 10)}`,
    })),
  };
}
