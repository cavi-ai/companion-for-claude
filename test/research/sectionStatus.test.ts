import { describe, expect, it } from "vitest";
import { buildDraftGrounding, groundingClaimFingerprint } from "../../src/research/draftGrounding";
import { parseDraftSections, renderManagedDocument, type DraftSectionEnvelope } from "../../src/research/draftSections";
import { buildProjectSnapshot, recordBasename } from "../../src/research/graph";
import { activeDocument, documentSections, sectionState } from "../../src/research/sectionStatus";
import type { ResearchRecord } from "../../src/research/types";

const P = "R/Project.md";
const records: ResearchRecord[] = [
  { path: P, title: "P", type: "research-project", project: P, question: "Q?", stage: "frame", status: "active" },
  { path: "R/Sources/S.md", title: "S", type: "research-source", project: P, sourceKind: "web" },
  { path: "R/Evidence/E.md", title: "E", type: "evidence", project: P, source: "R/Sources/S.md", locatorKind: "page", locatorValue: "2", excerpt: "x", reviewState: "reviewed" },
  { path: "R/Claims/C.md", title: "C", type: "claim", project: P, proposition: "C holds.", confidence: "high", reviewState: "reviewed", supports: ["R/Evidence/E.md"], challenges: [], contextualizes: [], limitations: [] },
  { path: "R/Documents/Outline.md", title: "Outline", type: "research-document", project: P, documentKind: "outline", claims: ["R/Claims/C.md"] },
];
const snapshot = buildProjectSnapshot(P, records, []);
const packet = buildDraftGrounding(snapshot, "R/Claims/C.md");
const base: DraftSectionEnvelope = { id: "c", claimPaths: ["R/Claims/C.md"], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [], provider: "anthropic", model: "m", generatedAt: "t", claimFingerprint: groundingClaimFingerprint(packet) };
const one = (envelope: DraftSectionEnvelope, body = "Body.") => parseDraftSections(renderManagedDocument("", [{ envelope, heading: "C", markdown: body }])).sections[0]!;

describe("section state", () => {
  it("names outline, drafted and changed sections", () => {
    expect(sectionState(snapshot, one({ ...base, provider: "companion" }))).toBe("outline");
    expect(sectionState(snapshot, one(base))).toBe("drafted");
    expect(sectionState(snapshot, { ...one(base), modifiedSinceReview: true })).toBe("changed");
    expect(sectionState(snapshot, one({ ...base, claimFingerprint: "stale" }))).toBe("changed");
  });

  it("prefers the draft document over the outline", () => {
    const withDraft = buildProjectSnapshot(P, [...records, { path: "R/Documents/Draft.md", title: "Draft", type: "research-document", project: P, documentKind: "draft", claims: [] }], []);
    expect(activeDocument(withDraft)?.path).toBe("R/Documents/Draft.md");
    expect(activeDocument(snapshot)?.path).toBe("R/Documents/Outline.md");
  });

  it("summarizes the active document's sections and survives a load failure", async () => {
    const doc = renderManagedDocument("", [{ envelope: { ...base, provider: "companion" }, heading: "C", markdown: "Body." }]);
    expect((await documentSections(snapshot, async () => parseDraftSections(doc)))?.sections).toEqual([{ id: "c", heading: "C", claimPath: "R/Claims/C.md", state: "outline" }]);
    const failed = await documentSections(snapshot, async () => { throw new Error("gone"); });
    expect(failed?.sections).toEqual([]);
    expect(failed?.parsed.issues).toEqual(["gone"]);
  });

  it("has a shared basename helper", () => {
    expect(recordBasename("Research/Evidence/E1.md")).toBe("E1");
    expect(recordBasename("Loose.MD")).toBe("Loose");
  });
});
