import { describe, expect, it } from "vitest";
import { validateRevisionResponse, type RevisionRequest } from "../../src/research/revisionPolicy";
import type { DraftGroundingPacket } from "../../src/research/draftGrounding";

const packet: DraftGroundingPacket = {
  projectPath: "R/Project.md",
  claim: { path: "R/Claims/C.md", title: "C", proposition: "Results vary by domain.", confidence: "moderate" },
  limitations: ["Only two domains were studied"],
  evidence: [
    { path: "R/Evidence/S.md", relation: "supports", sourcePath: "R/Sources/S.md", fingerprint: "s", citationKey: "smith2025", locatorKind: "page", locatorValue: "14", excerpt: "Results varied." },
    { path: "R/Evidence/C.md", relation: "challenges", sourcePath: "R/Sources/C.md", fingerprint: "c", citationKey: "jones2024", locatorKind: "page", locatorValue: "9", excerpt: "Variation was not significant." },
  ],
};

const request: RevisionRequest = { intent: "clarity", customInstruction: "Use direct language" };
const valid = {
  markdown: "Results differed by domain [@smith2025]. The difference was not significant in another study [@jones2024].",
  support: [
    { passage: "Results differed by domain [@smith2025].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/S.md"], citationKeys: ["smith2025"] },
    { passage: "The difference was not significant in another study [@jones2024].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/C.md"], citationKeys: ["jones2024"] },
  ],
  claimPreservation: [{ claimPath: "R/Claims/C.md", passage: "Results differed by domain [@smith2025].", status: "preserved" }],
  changes: [{ kind: "emphasis", severity: "warning", description: "Leads with the domain difference." }],
  gaps: [],
};

describe("claim-preserving revision policy", () => {
  it("accepts warning-only editorial shifts with exact grounding", () => {
    const result = validateRevisionResponse(packet, request, valid);
    expect(result.canAccept).toBe(true);
    expect(result.warnings).toEqual(["Leads with the domain difference."]);
    expect(result.violations).toEqual([]);
  });

  it.each(["claim-change", "factual-addition", "citation-change", "counterevidence-removal"] as const)("blocks %s declarations", (kind) => {
    const result = validateRevisionResponse(packet, request, { ...valid, changes: [{ kind, severity: "block", description: `Detected ${kind}` }] });
    expect(result.canAccept).toBe(false);
    expect(result.violations).toEqual([`Detected ${kind}`]);
  });

  it("does not let the provider downgrade a hard violation to a warning", () => {
    const result = validateRevisionResponse(packet, request, { ...valid, changes: [{ kind: "factual-addition", severity: "warning", description: "Added a new result." }] });
    expect(result.canAccept).toBe(false);
    expect(result.violations).toEqual(["Added a new result."]);
  });

  it("independently blocks certainty inflation and removal of an explicit limitation", () => {
    const original = `${valid.markdown}\n\nOnly two domains were studied.`;
    const inflatedPassage = "Results conclusively proved differences by domain [@smith2025].";
    const inflated = { ...valid, markdown: valid.markdown.replace(valid.support[0].passage, inflatedPassage), support: [{ ...valid.support[0], passage: inflatedPassage }, valid.support[1]], claimPreservation: [{ ...valid.claimPreservation[0], passage: inflatedPassage }], changes: [] };
    const result = validateRevisionResponse(packet, request, inflated, original);
    expect(result.canAccept).toBe(false);
    expect(result.violations.join(" ")).toMatch(/certainty.*moderate/i);
    expect(result.violations.join(" ")).toMatch(/removed limitation/i);
  });

  it("blocks an undeclared factual claim even when the provider calls it preserved", () => {
    const passage = "Results increased by 50% in every domain [@smith2025].";
    const adversarial = { ...valid, markdown: valid.markdown.replace(valid.support[0].passage, passage), support: [{ ...valid.support[0], passage }, valid.support[1]], claimPreservation: [{ ...valid.claimPreservation[0], passage }], changes: [] };
    const result = validateRevisionResponse(packet, request, adversarial, valid.markdown);
    expect(result.canAccept).toBe(false);
    expect(result.violations.join(" ")).toMatch(/protected factual vocabulary/i);
  });

  it.each(["Results originated on Mars [@smith2025].", "Results were fabricated [@smith2025]."])("blocks undeclared unsupported prose: %s", (passage) => {
    const adversarial = { ...valid, markdown: valid.markdown.replace(valid.support[0].passage, passage), support: [{ ...valid.support[0], passage }, valid.support[1]], claimPreservation: [{ ...valid.claimPreservation[0], passage }], changes: [] };
    const result = validateRevisionResponse(packet, request, adversarial, valid.markdown);
    expect(result.canAccept).toBe(false);
    expect(result.violations.join(" ")).toMatch(/protected factual vocabulary/i);
  });

  it("blocks unsupported factual heading vocabulary", () => {
    const result = validateRevisionResponse(packet, request, { ...valid, markdown: "## Results Prove a Martian Origin\n\n" + valid.markdown, changes: [] }, valid.markdown);
    expect(result.canAccept).toBe(false);
    expect(result.violations.join(" ")).toMatch(/heading|protected factual vocabulary/i);
  });

  it("rejects unsupported prose hidden under a heading", () => {
    expect(() => validateRevisionResponse(packet, request, { ...valid, markdown: "## Conclusion\nResults were fabricated.\n\n" + valid.markdown, changes: [] }, valid.markdown)).toThrow(/missing passage-level support/i);
  });

  it("protects non-Latin grounded prose", () => {
    const original = "结果因领域而异 [@smith2025]. The difference was not significant in another study [@jones2024].";
    const passage = "结果来自火星 [@smith2025].";
    const response = { ...valid, markdown: `${passage} ${valid.support[1].passage}`, support: [{ ...valid.support[0], passage }, valid.support[1]], claimPreservation: [{ ...valid.claimPreservation[0], passage }], changes: [] };
    expect(validateRevisionResponse(packet, request, response, original).canAccept).toBe(false);
  });

  it("allows punctuation-only changes inside grounded prose", () => {
    const original = "Evidence-based results varied [@smith2025]. The difference was not significant in another study [@jones2024].";
    const passage = "Evidence based results varied [@smith2025].";
    const response = { ...valid, markdown: `${passage} ${valid.support[1].passage}`, support: [{ ...valid.support[0], passage }, valid.support[1]], claimPreservation: [{ ...valid.claimPreservation[0], passage }], changes: [] };
    expect(validateRevisionResponse(packet, request, response, original).canAccept).toBe(true);
  });

  it("permits grounded paragraph reordering without moving citations between passages", () => {
    const reordered = { ...valid, markdown: `${valid.support[1].passage}\n\n${valid.support[0].passage}`, changes: [{ kind: "structure", severity: "warning", description: "Reorders grounded paragraphs." }] };
    expect(validateRevisionResponse(packet, request, reordered, `${valid.support[0].passage}\n\n${valid.support[1].passage}`).canAccept).toBe(true);
    const moved = { ...valid, markdown: "Results differed by domain [@jones2024]. The difference was not significant in another study [@smith2025].", support: [{ ...valid.support[0], passage: "Results differed by domain [@jones2024].", evidencePaths: ["R/Evidence/C.md"], citationKeys: ["jones2024"] }, { ...valid.support[1], passage: "The difference was not significant in another study [@smith2025].", evidencePaths: ["R/Evidence/S.md"], citationKeys: ["smith2025"] }], claimPreservation: [{ ...valid.claimPreservation[0], passage: "Results differed by domain [@jones2024]." }] };
    expect(validateRevisionResponse(packet, request, moved, valid.markdown).canAccept).toBe(false);
  });

  it("blocks undeclared citation substitution, addition, and removal", () => {
    const cases = [
      { markdown: valid.markdown.replace("[@smith2025]", "[@jones2024]"), support: [{ passage: "Results differed by domain [@jones2024].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/C.md"], citationKeys: ["jones2024"] }, valid.support[1]] },
      { markdown: valid.markdown.replace("[@smith2025]", "[@smith2025] [@jones2024]"), support: [{ passage: "Results differed by domain [@smith2025] [@jones2024].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/S.md", "R/Evidence/C.md"], citationKeys: ["smith2025", "jones2024"] }, valid.support[1]] },
      { markdown: valid.markdown.replace("Results differed by domain [@smith2025]. ", ""), support: [valid.support[1]] },
    ];
    for (const { markdown, support } of cases) {
      try {
        const result = validateRevisionResponse(packet, request, { ...valid, markdown, support, claimPreservation: [{ ...valid.claimPreservation[0], passage: support[0].passage }] }, valid.markdown);
        expect(result.canAccept).toBe(false);
        expect(result.violations.join(" ")).toMatch(/citation/i);
      } catch (error) {
        expect(String(error)).toMatch(/support|challenging evidence/i);
      }
    }
  });

  it("requires every trusted challenge to remain visible", () => {
    const packetWithTwoChallenges = { ...packet, evidence: [...packet.evidence, { ...packet.evidence[1], path: "R/Evidence/C2.md", fingerprint: "c2", citationKey: "lee2023", excerpt: "A second challenge." }] };
    const original = `${valid.markdown} A second challenge remained [@lee2023].`;
    const result = validateRevisionResponse(packetWithTwoChallenges, request, valid, original);
    expect(result.canAccept).toBe(false);
    expect(result.violations.join(" ")).toMatch(/challenging evidence.*C2/i);
  });

  it("rejects a missing claim-preservation passage", () => {
    expect(() => validateRevisionResponse(packet, request, { ...valid, claimPreservation: [{ ...valid.claimPreservation[0], passage: "Not in the revision" }] })).toThrow(/claim-preservation passage/i);
  });

  it("rejects unknown presets and blank custom-only instructions", () => {
    expect(() => validateRevisionResponse(packet, { intent: "custom", customInstruction: "  " }, valid)).toThrow(/custom instruction/i);
    expect(() => validateRevisionResponse(packet, { intent: "invented" as never }, valid)).toThrow(/revision intent/i);
  });
});
