import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { buildDraftGrounding } from "../../src/research/draftGrounding";
import type { ResearchRecord } from "../../src/research/types";

const records: ResearchRecord[] = [
  { path: "R/Project.md", title: "R", type: "research-project", project: "R/Project.md", question: "How variable?", stage: "shape", status: "active" },
  { path: "R/Sources/Smith.md", title: "Smith", type: "research-source", project: "R/Project.md", sourceKind: "zotero", zoteroKey: "SMITH2025", contentFingerprint: "sha256:smith" },
  { path: "R/Sources/Jones.md", title: "Jones", type: "research-source", project: "R/Project.md", sourceKind: "doi", doi: "10.1000/JONES.2024", contentFingerprint: "sha256:jones" },
  { path: "R/Evidence/Support.md", title: "Support", type: "evidence", project: "R/Project.md", source: "R/Sources/Smith.md", sourceFingerprint: "sha256:smith", locatorKind: "page", locatorValue: "14", excerpt: "Performance varied by domain.", reviewState: "reviewed" },
  { path: "R/Evidence/Challenge.md", title: "Challenge", type: "evidence", project: "R/Project.md", source: "R/Sources/Jones.md", sourceFingerprint: "sha256:jones", locatorKind: "section", locatorValue: "Results", excerpt: "Variation was not significant.", reviewState: "reviewed" },
  { path: "R/Claims/C.md", title: "External validity", type: "claim", project: "R/Project.md", proposition: "Performance varies by domain.", confidence: "moderate", reviewState: "reviewed", supports: ["R/Evidence/Support.md"], challenges: ["R/Evidence/Challenge.md"], contextualizes: [], limitations: ["Evidence covers two domains"] },
];

describe("section drafting grounding", () => {
  it("builds an allowlisted packet from reviewed, locatable, non-stale evidence", () => {
    const packet = buildDraftGrounding(buildProjectSnapshot("R/Project.md", records, []), "R/Claims/C.md");

    expect(packet.claim).toMatchObject({ path: "R/Claims/C.md", proposition: "Performance varies by domain." });
    expect(packet.evidence.map(({ relation, citationKey, excerpt }) => ({ relation, citationKey, excerpt }))).toEqual([
      { relation: "supports", citationKey: "SMITH2025", excerpt: "Performance varied by domain." },
      { relation: "challenges", citationKey: "doi-10-1000-jones-2024", excerpt: "Variation was not significant." },
    ]);
    expect(packet.limitations).toEqual(["Evidence covers two domains"]);
  });

  it.each([
    ["proposed claim", records.map((record) => record.type === "claim" ? { ...record, reviewState: "proposed" as const } : record), /reviewed claim/i],
    ["stale support", records.map((record) => record.type === "research-source" && record.path.endsWith("Smith.md") ? { ...record, contentFingerprint: "sha256:new" } : record), /trusted supporting evidence/i],
  ])("blocks %s", (_name, unsafe, message) => {
    expect(() => buildDraftGrounding(buildProjectSnapshot("R/Project.md", unsafe, []), "R/Claims/C.md")).toThrow(message);
  });

  it("blocks ambiguous citation-key collisions across different sources", () => {
    const collision = records.map((record) => record.type === "research-source" ? { ...record, zoteroKey: "same" } : record);
    expect(() => buildDraftGrounding(buildProjectSnapshot("R/Project.md", collision, []), "R/Claims/C.md")).toThrow(/citation key collision.*same/i);
  });
});
