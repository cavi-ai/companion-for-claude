import type { DraftGroundingPacket } from "./draftGrounding";

export interface DraftSupportEntry {
  passage: string;
  claimPath: string;
  evidencePaths: string[];
  citationKeys: string[];
}

export interface ValidatedDraftResponse {
  markdown: string;
  support: DraftSupportEntry[];
  gaps: string[];
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && Boolean(item.trim()));
}

function citations(markdown: string): string[] {
  return [...markdown.matchAll(/\[@([A-Za-z0-9][A-Za-z0-9._:-]*)\]/g)].map((match) => match[1] ?? "");
}

function proseBlocks(markdown: string): string[] {
  return markdown.replace(/^#{1,6}\s+.*$/gm, "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
}

function parseResponse(value: unknown): ValidatedDraftResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Draft response must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.markdown !== "string" || !raw.markdown.trim()) throw new Error("Draft response Markdown must not be empty");
  if (raw.markdown.includes("<!-- cavi:draft-section")) throw new Error("Draft response contains a reserved Companion marker");
  if (!Array.isArray(raw.support) || !raw.support.length) throw new Error("Draft response must include passage-level support");
  if (!strings(raw.gaps ?? [])) throw new Error("Draft response gaps must be a list of non-empty strings");
  const support = raw.support.map((entry): DraftSupportEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Draft support entries must be objects");
    const item = entry as Record<string, unknown>;
    if (typeof item.passage !== "string" || !item.passage.trim()) throw new Error("Draft support passage must not be empty");
    if (typeof item.claimPath !== "string" || !item.claimPath.trim()) throw new Error("Draft support claimPath must not be empty");
    if (!strings(item.evidencePaths) || !strings(item.citationKeys)) throw new Error("Draft support evidencePaths and citationKeys must be non-empty string lists");
    return { passage: item.passage, claimPath: item.claimPath, evidencePaths: item.evidencePaths, citationKeys: item.citationKeys };
  });
  return { markdown: raw.markdown.trim(), support, gaps: (raw.gaps ?? []) as string[] };
}

export function validateDraftResponse(packet: DraftGroundingPacket, value: unknown): ValidatedDraftResponse {
  const response = parseResponse(value);
  const allowedEvidence = new Map(packet.evidence.map((item) => [item.path, item]));
  const allowedCitations = new Set(packet.evidence.map(({ citationKey }) => citationKey));
  const usedEvidence = new Set<string>();
  const manifestedCitations = new Set<string>();

  const withoutCanonical = response.markdown.replace(/\[@[A-Za-z0-9][A-Za-z0-9._:-]*\]/g, "");
  if (/(?:\[[^\]]*@[^\]]*\]|\[(?:\^?\d+[^\]]*)\]|\([^)]*[A-Za-z][^)]*,\s*(?:19|20)\d{2}[a-z]?[^)]*\))/i.test(withoutCanonical)) {
    throw new Error("Draft contains noncanonical citation syntax; use only [@key]");
  }

  for (const key of citations(response.markdown)) {
    if (!allowedCitations.has(key)) throw new Error(`Draft contains unknown citation: ${key}`);
  }
  for (const item of response.support) {
    if (!response.markdown.includes(item.passage)) throw new Error(`Support passage is not present in the draft: ${item.passage}`);
    if (item.claimPath !== packet.claim.path) throw new Error(`Support entry references an unknown claim: ${item.claimPath}`);
    for (const path of item.evidencePaths) {
      const evidence = allowedEvidence.get(path);
      if (!evidence) throw new Error(`Support entry references unknown evidence: ${path}`);
      usedEvidence.add(path);
      if (!item.citationKeys.includes(evidence.citationKey)) throw new Error(`Support entry omits the citation for evidence: ${path}`);
    }
    for (const key of item.citationKeys) {
      if (!allowedCitations.has(key)) throw new Error(`Support entry contains unknown citation: ${key}`);
      if (!item.passage.includes(`[@${key}]`)) throw new Error(`Support passage omits its declared citation: ${key}`);
      if (!item.evidencePaths.some((path) => allowedEvidence.get(path)?.citationKey === key)) throw new Error(`Support entry has no evidence lineage for citation: ${key}`);
      manifestedCitations.add(key);
    }
  }
  for (const block of proseBlocks(response.markdown)) {
    let remaining = block;
    for (const { passage } of response.support) if (block.includes(passage)) remaining = remaining.replace(passage, "");
    if (remaining.replace(/[\s.,;:!?—–-]+/g, "")) throw new Error(`Draft prose is missing passage-level support: ${block}`);
  }
  for (const key of citations(response.markdown)) {
    if (!manifestedCitations.has(key)) throw new Error(`Citation is missing passage-level support: ${key}`);
  }
  const challenge = packet.evidence.find(({ relation }) => relation === "challenges");
  if (challenge && !packet.evidence.some(({ path, relation }) => relation === "challenges" && usedEvidence.has(path))) {
    throw new Error("Draft must keep trusted challenging evidence visible");
  }
  if (!packet.evidence.some(({ path, relation }) => relation === "supports" && usedEvidence.has(path))) {
    throw new Error("Draft must use trusted supporting evidence");
  }
  return response;
}
