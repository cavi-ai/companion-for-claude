import type { Provider } from "../providers/types";
import { buildDraftGrounding, groundingClaimFingerprint, type DraftGroundingPacket } from "./draftGrounding";
import { buildDraftRequest, parseDraftResponse } from "./draftRequest";
import type { DraftSectionEnvelope, ParsedDraftSection } from "./draftSections";
import { validateDraftResponse, type ValidatedDraftResponse } from "./draftValidation";
import type { ProjectSnapshot } from "./graph";

export interface DraftCoordinatorDeps {
  selection(): { provider: Provider; model: string };
  maxTokens(): number;
  now?(): string;
}

export interface DraftPreview {
  section: ParsedDraftSection;
  packet: DraftGroundingPacket;
  response: ValidatedDraftResponse;
  envelope: DraftSectionEnvelope;
}

const DRAFT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["markdown", "support", "gaps"],
  properties: {
    markdown: { type: "string", minLength: 1 },
    support: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["passage", "claimPath", "evidencePaths", "citationKeys"],
        properties: {
          passage: { type: "string", minLength: 1 },
          claimPath: { type: "string", minLength: 1 },
          evidencePaths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          citationKeys: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
    gaps: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

function groundedFallback(packet: DraftGroundingPacket, section: ParsedDraftSection): ValidatedDraftResponse {
  const heading = section.markdown.split("\n").find((line) => /^#{1,6}\s+/.test(line.trim()))?.trim();
  const supporting = packet.evidence.filter(({ relation }) => relation === "supports");
  const challenging = packet.evidence.filter(({ relation }) => relation === "challenges");
  const passage = `${packet.claim.proposition} ${supporting.map(({ citationKey }) => `[@${citationKey}]`).join(" ")}`.trim();
  const challengePassage = challenging.length
    ? `Reviewed evidence also challenges this claim ${challenging.map(({ citationKey }) => `[@${citationKey}]`).join(" ")}.`
    : "";
  const markdown = [heading, passage, challengePassage].filter(Boolean).join("\n\n");
  const support = [
    { passage, claimPath: packet.claim.path, evidencePaths: supporting.map(({ path }) => path), citationKeys: supporting.map(({ citationKey }) => citationKey) },
    ...(challengePassage ? [{ passage: challengePassage, claimPath: packet.claim.path, evidencePaths: challenging.map(({ path }) => path), citationKeys: challenging.map(({ citationKey }) => citationKey) }] : []),
  ];
  return validateDraftResponse(packet, {
    markdown,
    support,
    gaps: ["The selected model did not return a valid grounded draft; Companion generated this minimal reviewed-claim fallback.", ...packet.limitations],
  });
}

export class DraftCoordinator {
  constructor(private readonly deps: DraftCoordinatorDeps) {}

  async preview(snapshot: ProjectSnapshot, section: ParsedDraftSection, signal?: AbortSignal): Promise<DraftPreview> {
    const [claimPath] = section.envelope.claimPaths;
    if (!claimPath || section.envelope.claimPaths.length !== 1) throw new Error("Section drafting requires exactly one linked claim");
    const packet = buildDraftGrounding(snapshot, claimPath);
    const { provider, model } = this.deps.selection();
    if (!provider.hasCredentials()) throw new Error(`The selected ${provider.label} provider is missing its credential or connection`);
    const request = buildDraftRequest(packet);
    const completion = { ...request, model, maxTokens: this.deps.maxTokens(), temperature: 0, responseFormat: "json" as const, responseSchema: DRAFT_RESPONSE_SCHEMA, ...(signal ? { signal } : {}) };
    let raw = await provider.complete(completion);
    let response: ValidatedDraftResponse;
    try {
      response = parseDraftResponse(packet, raw);
    } catch (error) {
      const feedback = error instanceof Error ? error.message : "The response did not match the required schema";
      raw = await provider.complete({
        ...completion,
        messages: [...completion.messages, { role: "assistant", content: raw }, { role: "user", content: `Your previous JSON was rejected: ${feedback}. Return one complete corrected JSON object matching responseSchema.` }],
      });
      try {
        response = parseDraftResponse(packet, raw);
      } catch {
        response = groundedFallback(packet, section);
      }
    }
    const citations = [...new Map(packet.evidence.map(({ citationKey: key, sourcePath }) => [sourcePath, { key, sourcePath }])).values()];
    return {
      section,
      packet,
      response,
      envelope: {
        id: section.envelope.id,
        claimPaths: [claimPath],
        evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })),
        citations,
        provider: provider.id,
        model,
        generatedAt: this.deps.now?.() ?? new Date().toISOString(),
        claimFingerprint: groundingClaimFingerprint(packet),
      },
    };
  }
}
