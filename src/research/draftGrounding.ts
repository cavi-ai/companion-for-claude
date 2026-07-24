import { compareCodeUnits, isTrustedEvidence, type ProjectSnapshot } from "./graph";
import type { EvidenceRelation, ResearchSourceRecord } from "./types";

export interface DraftGroundingEvidence {
  path: string;
  relation: EvidenceRelation;
  sourcePath: string;
  sourceFingerprint?: string;
  fingerprint: string;
  citationKey: string;
  locatorKind: string;
  locatorValue: string;
  excerpt: string;
  interpretation?: string;
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function groundingEvidenceFingerprint(value: Omit<DraftGroundingEvidence, "fingerprint">): string {
  return fingerprint(JSON.stringify(value));
}

export function groundingClaimFingerprint(packet: Pick<DraftGroundingPacket, "claim" | "limitations">): string {
  return fingerprint(JSON.stringify({ claim: packet.claim, limitations: packet.limitations }));
}

export interface DraftGroundingPacket {
  projectPath: string;
  claim: { path: string; title: string; proposition: string; confidence: string };
  limitations: string[];
  evidence: DraftGroundingEvidence[];
}

function slug(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function citationKeyForSource(source: ResearchSourceRecord): string {
  if (source.zoteroKey?.trim()) return source.zoteroKey.trim();
  if (source.doi?.trim()) return `doi-${slug(source.doi)}`;
  if (source.arxivId?.trim()) return `arxiv-${slug(source.arxivId)}`;
  const path = source.path.replace(/\.md$/i, "").split("/").pop() ?? source.path;
  return `source-${slug(path) || "untitled"}`;
}

export function buildDraftGrounding(snapshot: ProjectSnapshot, claimPath: string): DraftGroundingPacket {
  const claim = snapshot.claims.find(({ path }) => path === claimPath);
  if (!claim) throw new Error(`Claim is not part of project: ${claimPath}`);
  if (claim.reviewState !== "reviewed") throw new Error(`Section drafting requires a reviewed claim: ${claimPath}`);

  const relations: Array<[EvidenceRelation, string[]]> = [
    ["supports", claim.supporting],
    ["challenges", claim.challenging],
    ["contextualizes", claim.contextual],
  ];
  const evidence: DraftGroundingEvidence[] = [];
  let trustedSupport = 0;
  for (const [relation, paths] of relations) {
    for (const path of paths) {
      const item = snapshot.evidence.find((candidate) => candidate.path === path);
      const source = item ? snapshot.sources.find((candidate) => candidate.path === item.source) : undefined;
      if (!isTrustedEvidence(item, source) || !item || !source || !item.locatorKind || !item.locatorValue) continue;
      if (relation === "supports") trustedSupport += 1;
      const grounded = {
        path: item.path,
        relation,
        sourcePath: source.path,
        ...(item.sourceFingerprint ? { sourceFingerprint: item.sourceFingerprint } : {}),
        citationKey: citationKeyForSource(source),
        locatorKind: item.locatorKind,
        locatorValue: item.locatorValue,
        excerpt: item.excerpt,
        ...(item.interpretation ? { interpretation: item.interpretation } : {}),
      };
      evidence.push({ ...grounded, fingerprint: groundingEvidenceFingerprint(grounded) });
    }
  }
  if (!trustedSupport) throw new Error(`Section drafting requires trusted supporting evidence for claim: ${claimPath}`);
  const citationOwners = new Map<string, string>();
  for (const item of evidence) {
    const owner = citationOwners.get(item.citationKey);
    if (owner && owner !== item.sourcePath) throw new Error(`Citation key collision for ${item.citationKey}: ${owner} and ${item.sourcePath}`);
    citationOwners.set(item.citationKey, item.sourcePath);
  }
  evidence.sort((left, right) => {
    const order: Record<EvidenceRelation, number> = { supports: 0, challenges: 1, contextualizes: 2 };
    return order[left.relation] - order[right.relation] || compareCodeUnits(left.path, right.path);
  });
  return {
    projectPath: snapshot.project.path,
    claim: { path: claim.path, title: claim.title, proposition: claim.proposition, confidence: claim.confidence },
    limitations: [...claim.limitations],
    evidence,
  };
}
