import type { DraftGroundingPacket } from "./draftGrounding";
import { validateDraftResponse, type DraftSupportEntry } from "./draftValidation";

export type RevisionIntent = "clarity" | "concision" | "audience" | "structure" | "skeptical" | "custom";
export type RevisionChangeKind = "clarity" | "concision" | "audience" | "structure" | "skeptical" | "certainty" | "emphasis" | "claim-change" | "factual-addition" | "citation-change" | "counterevidence-removal";

export interface RevisionRequest { intent: RevisionIntent; customInstruction?: string; }
export interface RevisionChange { kind: RevisionChangeKind; severity: "warning" | "block"; description: string; }
export interface ClaimPreservationEntry { claimPath: string; passage: string; status: "preserved"; }
export interface ValidatedRevisionResponse {
  markdown: string;
  support: DraftSupportEntry[];
  claimPreservation: ClaimPreservationEntry[];
  changes: RevisionChange[];
  gaps: string[];
  warnings: string[];
  violations: string[];
  canAccept: boolean;
}

const INTENTS = new Set<RevisionIntent>(["clarity", "concision", "audience", "structure", "skeptical", "custom"]);
const KINDS = new Set<RevisionChangeKind>(["clarity", "concision", "audience", "structure", "skeptical", "certainty", "emphasis", "claim-change", "factual-addition", "citation-change", "counterevidence-removal"]);
const HARD_KINDS = new Set<RevisionChangeKind>(["claim-change", "factual-addition", "citation-change", "counterevidence-removal"]);

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function citationSequence(markdown: string): string[] {
  return [...markdown.matchAll(/\[@([A-Za-z0-9][A-Za-z0-9._:-]*)\]/g)].map((match) => match[1] ?? "");
}

function groundedPassageSignatures(markdown: string): string[] {
  return markdown.replace(/^#{1,6}\s+.*$/gm, "").split(/\n\s*\n/).map((block) => block.trim()).filter((block) => /\[@[A-Za-z0-9]/.test(block)).map((block) => {
    const normalized = block.normalize("NFKC").toLowerCase().replace(/\[@([A-Za-z0-9][A-Za-z0-9._:-]*)\]/g, " citation:$1 ");
    return (normalized.match(/citation:[A-Za-z0-9._:-]+|[\p{L}\p{N}]+/gu) ?? []).filter((token) => token !== "a" && token !== "an" && token !== "the").join(" ");
  }).sort();
}

function headingSignatures(markdown: string): string[] {
  return [...markdown.normalize("NFKC").toLowerCase().matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => (match[1]?.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token !== "a" && token !== "an" && token !== "the").join(" ")).sort();
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateRevisionResponse(packet: DraftGroundingPacket, request: RevisionRequest, value: unknown, originalMarkdown?: string): ValidatedRevisionResponse {
  if (!INTENTS.has(request.intent)) throw new Error(`Unsupported revision intent: ${String(request.intent)}`);
  if (request.intent === "custom" && !request.customInstruction?.trim()) throw new Error("A custom revision requires a custom instruction");
  if ((request.customInstruction?.trim().length ?? 0) > 1000) throw new Error("Custom revision instruction must be 1000 characters or fewer");
  const raw = record(value, "Revision response must be an object");
  const grounded = validateDraftResponse(packet, raw);
  if (!Array.isArray(raw.claimPreservation) || !raw.claimPreservation.length) throw new Error("Revision response must include claim preservation");
  const claimPreservation = raw.claimPreservation.map((entry): ClaimPreservationEntry => {
    const item = record(entry, "Claim preservation entries must be objects");
    if (item.claimPath !== packet.claim.path || typeof item.passage !== "string" || item.status !== "preserved") throw new Error("Invalid claim preservation entry");
    if (!grounded.markdown.includes(item.passage)) throw new Error(`Claim-preservation passage is not present in the revision: ${item.passage}`);
    return { claimPath: item.claimPath, passage: item.passage, status: item.status };
  });
  if (!Array.isArray(raw.changes)) throw new Error("Revision response changes must be a list");
  const changes = raw.changes.map((entry): RevisionChange => {
    const item = record(entry, "Revision change entries must be objects");
    if (typeof item.kind !== "string" || !KINDS.has(item.kind as RevisionChangeKind) || (item.severity !== "warning" && item.severity !== "block") || typeof item.description !== "string" || !item.description.trim()) throw new Error("Invalid revision change entry");
    return { kind: item.kind as RevisionChangeKind, severity: item.severity, description: item.description.trim() };
  });
  const warnings = changes.filter(({ kind, severity }) => severity === "warning" && !HARD_KINDS.has(kind)).map(({ description }) => description);
  const violations = changes.filter(({ kind, severity }) => severity === "block" || HARD_KINDS.has(kind)).map(({ description }) => description);
  if (originalMarkdown) {
    const originalCitations = citationSequence(originalMarkdown);
    const revisedCitations = citationSequence(grounded.markdown);
    if (!sameList([...originalCitations].sort(), [...revisedCitations].sort())) violations.push("Revision changed the accepted citation set");
    if (!sameList(groundedPassageSignatures(originalMarkdown), groundedPassageSignatures(grounded.markdown))) violations.push("Revision changed protected factual vocabulary or citation attribution in grounded prose");
    if (!sameList(headingSignatures(originalMarkdown), headingSignatures(grounded.markdown))) violations.push("Revision changed protected heading vocabulary");
    const originalCitationSet = new Set(originalCitations);
    const usedEvidence = new Set(grounded.support.flatMap(({ evidencePaths }) => evidencePaths));
    for (const evidence of packet.evidence) {
      if ((evidence.relation === "challenges" || evidence.relation === "contextualizes") && originalCitationSet.has(evidence.citationKey) && !usedEvidence.has(evidence.path)) {
        violations.push(`Revision removed ${evidence.relation === "challenges" ? "challenging" : "contextual"} evidence: ${evidence.path}`);
      }
    }
  }
  if (packet.claim.confidence !== "high" && /\b(?:conclusively|proves?|proven|certainly|definitively|always|never)\b/i.test(grounded.markdown)) violations.push(`Revision inflates certainty beyond the reviewed ${packet.claim.confidence} confidence`);
  if (originalMarkdown) for (const limitation of packet.limitations) {
    if (originalMarkdown.includes(limitation) && !grounded.markdown.includes(limitation)) violations.push(`Revision removed limitation: ${limitation}`);
  }
  return { ...grounded, claimPreservation, changes, warnings, violations, canAccept: violations.length === 0 };
}
