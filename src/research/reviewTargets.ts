import { isStaleEvidence, type ProjectClaim, type ProjectSnapshot } from "./graph";
import type { EvidenceRecord, ResearchSourceRecord } from "./types";

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The named item, else first proposed, then first stale, then first without a locator. */
export function pickEvidenceForReview(snapshot: ProjectSnapshot, path?: string): EvidenceRecord | undefined {
  if (path) return snapshot.evidence.find((item) => item.path === path);
  const sourceOf = (item: EvidenceRecord) => snapshot.sources.find((source) => source.path === item.source);
  return snapshot.evidence.find(({ reviewState }) => reviewState === "proposed")
    ?? snapshot.evidence.find((item) => isStaleEvidence(item, sourceOf(item)))
    ?? snapshot.evidence.find(({ locatorKind, locatorValue }) => !locatorKind || !locatorValue?.trim());
}

export function pickClaimForReview(snapshot: ProjectSnapshot, path?: string): ProjectClaim | undefined {
  if (path) return snapshot.claims.find((claim) => claim.path === path);
  return snapshot.claims.find(({ reviewState }) => reviewState === "proposed")
    ?? snapshot.claims.find(({ reviewState }) => reviewState === "rejected")
    ?? snapshot.claims.find((claim) => claim.trustedSupportCount === 0)
    ?? snapshot.claims.find((claim) => claim.challenging.length > 0 && !claim.limitations.length);
}

/** Text around the passage in the current source; null when it no longer appears, undefined when the source has no readable text. */
export function passageContext(source: ResearchSourceRecord | undefined, excerpt: string, radius = 300): string | null | undefined {
  if (!source || source.sourceKind === "pdf" || typeof source.capturedContent !== "string") return undefined;
  const text = collapse(source.capturedContent);
  const needle = collapse(excerpt);
  const index = needle ? text.indexOf(needle) : -1;
  if (index < 0) return null;
  return `${index > radius ? "…" : ""}${text.slice(Math.max(0, index - radius), index + needle.length + radius)}${index + needle.length + radius < text.length ? "…" : ""}`;
}
