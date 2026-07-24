import type { Provider } from "../providers/types";
import { buildDraftGrounding, groundingClaimFingerprint, type DraftGroundingPacket } from "./draftGrounding";
import { draftMarkdownFingerprint, type DraftSectionEnvelope, type ParsedDraftSection } from "./draftSections";
import type { ProjectSnapshot } from "./graph";
import { buildRevisionRequest, parseRevisionResponse } from "./revisionRequest";
import type { RevisionRequest, ValidatedRevisionResponse } from "./revisionPolicy";

export interface RevisionCoordinatorDeps { selection(): { provider: Provider; model: string }; maxTokens(): number; now?(): string; }
export interface RevisionPreview { section: ParsedDraftSection; packet: DraftGroundingPacket; request: RevisionRequest; response: ValidatedRevisionResponse; envelope: DraftSectionEnvelope; }

const RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["markdown", "support", "claimPreservation", "changes", "gaps"],
  properties: {
    markdown: { type: "string", minLength: 1 },
    support: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["passage", "claimPath", "evidencePaths", "citationKeys"], properties: { passage: { type: "string" }, claimPath: { type: "string" }, evidencePaths: { type: "array", items: { type: "string" } }, citationKeys: { type: "array", items: { type: "string" } } } } },
    claimPreservation: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["claimPath", "passage", "status"], properties: { claimPath: { type: "string" }, passage: { type: "string" }, status: { const: "preserved" } } } },
    changes: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "severity", "description"], properties: { kind: { type: "string" }, severity: { enum: ["warning", "block"] }, description: { type: "string" } } } },
    gaps: { type: "array", items: { type: "string" } },
  },
} as const;

function sameGrounding(packet: DraftGroundingPacket, section: ParsedDraftSection): boolean {
  return groundingClaimFingerprint(packet) === section.envelope.claimFingerprint
    && JSON.stringify(packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint }))) === JSON.stringify(section.envelope.evidence);
}

export class RevisionCoordinator {
  constructor(private readonly deps: RevisionCoordinatorDeps) {}

  async preview(snapshot: ProjectSnapshot, section: ParsedDraftSection, request: RevisionRequest, signal?: AbortSignal): Promise<RevisionPreview> {
    if (section.envelope.provider === "companion") throw new Error("Revision requires an accepted section");
    if (section.modifiedSinceReview) throw new Error("Revision requires a section that has not been modified since review");
    const [claimPath] = section.envelope.claimPaths;
    if (!claimPath || section.envelope.claimPaths.length !== 1) throw new Error("Revision requires exactly one linked claim");
    const packet = buildDraftGrounding(snapshot, claimPath);
    if (!sameGrounding(packet, section)) throw new Error("Section grounding changed since the accepted draft");
    const { provider, model } = this.deps.selection();
    if (!provider.hasCredentials()) throw new Error(`The selected ${provider.label} provider is missing its credential or connection`);
    const built = buildRevisionRequest(packet, section.markdown, request);
    const completion = { ...built, model, maxTokens: this.deps.maxTokens(), temperature: 0, responseFormat: "json" as const, responseSchema: RESPONSE_SCHEMA, ...(signal ? { signal } : {}) };
    let raw = await provider.complete(completion);
    let response: ValidatedRevisionResponse;
    try { response = parseRevisionResponse(packet, request, raw, section.markdown); }
    catch (error) {
      const feedback = error instanceof Error ? error.message : "The response did not match the required schema";
      raw = await provider.complete({ ...completion, messages: [...completion.messages, { role: "assistant", content: raw }, { role: "user", content: `Your previous JSON was rejected: ${feedback}. Return one complete corrected JSON object matching responseSchema.` }] });
      response = parseRevisionResponse(packet, request, raw, section.markdown);
    }
    return {
      section, packet, request, response,
      envelope: { ...section.envelope, provider: provider.id, model, generatedAt: this.deps.now?.() ?? new Date().toISOString(), revisionIntent: request.intent, ...(request.customInstruction?.trim() ? { revisionInstruction: request.customInstruction.trim() } : {}), revisedFromFingerprint: draftMarkdownFingerprint(section.markdown), claimFingerprint: groundingClaimFingerprint(packet), evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })) },
    };
  }
}
