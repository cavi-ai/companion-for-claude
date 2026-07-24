import { describe, expect, it } from "vitest";
import { validateDraftResponse } from "../../src/research/draftValidation";
import type { DraftGroundingPacket } from "../../src/research/draftGrounding";

const packet: DraftGroundingPacket = {
  projectPath: "R/Project.md",
  claim: { path: "R/Claims/C.md", title: "C", proposition: "Results vary.", confidence: "moderate" },
  limitations: ["Two domains"],
  evidence: [
    { path: "R/Evidence/S.md", relation: "supports", sourcePath: "R/Sources/S.md", sourceFingerprint: "sha256:s", citationKey: "smith2025", locatorKind: "page", locatorValue: "14", excerpt: "Results varied." },
    { path: "R/Evidence/C.md", relation: "challenges", sourcePath: "R/Sources/C.md", sourceFingerprint: "sha256:c", citationKey: "jones2024", locatorKind: "section", locatorValue: "Results", excerpt: "Variation was not significant." },
  ],
};

const valid = {
  markdown: "Results varied across the observed domains [@smith2025]. Jones found no significant variation, so the evidence remains mixed [@jones2024].",
  support: [
    { passage: "Results varied across the observed domains [@smith2025].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/S.md"], citationKeys: ["smith2025"] },
    { passage: "Jones found no significant variation, so the evidence remains mixed [@jones2024].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/C.md"], citationKeys: ["jones2024"] },
  ],
  gaps: [],
};

describe("grounded section draft validation", () => {
  it("accepts allowlisted citations with passage-level evidence lineage", () => {
    expect(validateDraftResponse(packet, valid)).toEqual(valid);
  });

  it("rejects invented citations", () => {
    const response = { ...valid, markdown: `${valid.markdown} Another result [@invented].` };
    expect(() => validateDraftResponse(packet, response)).toThrow(/unknown citation.*invented/i);
  });

  it("requires captured challenging evidence to remain visible", () => {
    const response = { markdown: "Results varied [@smith2025].", support: [{ ...valid.support[0], passage: "Results varied [@smith2025]." }], gaps: [] };
    expect(() => validateDraftResponse(packet, response)).toThrow(/challenging evidence/i);
  });

  it("rejects support entries whose passage is absent from the draft", () => {
    const response = { ...valid, support: [{ ...valid.support[0], passage: "A sentence the user cannot inspect." }, valid.support[1]] };
    expect(() => validateDraftResponse(packet, response)).toThrow(/passage.*not present/i);
  });

  it("requires evidence lineage for every declared citation", () => {
    const response = { ...valid, support: [{ ...valid.support[0], passage: valid.markdown, citationKeys: ["smith2025", "jones2024"] }] };
    expect(() => validateDraftResponse(packet, response)).toThrow(/no evidence lineage.*jones2024/i);
  });

  it("rejects uncited prose outside the support manifest", () => {
    expect(() => validateDraftResponse(packet, { ...valid, markdown: `${valid.markdown}\n\nInvented factual sentence.` })).toThrow(/missing passage-level support/i);
  });

  it.each(["Results varied [@smith2025 p. 4].", "Results varied [@smith2025]. (Smith, 2025)", "Results varied [@smith2025]. [1]", "Results varied [@smith2025]. [^1]", "Results varied [@smith2025]. (smith, 2025)", "Results varied [@smith2025]. (Smith & Jones, 2025)"])("rejects noncanonical citation syntax: %s", (markdown) => {
    expect(() => validateDraftResponse(packet, { ...valid, markdown })).toThrow(/noncanonical citation syntax/i);
  });
});
