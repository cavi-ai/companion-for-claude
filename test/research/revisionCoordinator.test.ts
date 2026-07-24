import { describe, expect, it, vi } from "vitest";
import { RevisionCoordinator } from "../../src/research/revisionCoordinator";
import { buildDraftGrounding, groundingClaimFingerprint } from "../../src/research/draftGrounding";
import { buildProjectSnapshot } from "../../src/research/graph";
import { parseDraftSections, renderDraftSection } from "../../src/research/draftSections";
import type { Provider } from "../../src/providers/types";
import type { ResearchRecord } from "../../src/research/types";

const records: ResearchRecord[] = [
  { path: "R/Project.md", title: "R", type: "research-project", project: "R/Project.md", question: "Why?", stage: "write", status: "active" },
  { path: "R/Sources/S.md", title: "S", type: "research-source", project: "R/Project.md", sourceKind: "zotero", zoteroKey: "smith", contentFingerprint: "sha256:s" },
  { path: "R/Evidence/E.md", title: "E", type: "evidence", project: "R/Project.md", source: "R/Sources/S.md", sourceFingerprint: "sha256:s", locatorKind: "page", locatorValue: "1", excerpt: "Results varied.", reviewState: "reviewed" },
  { path: "R/Claims/C.md", title: "C", type: "claim", project: "R/Project.md", proposition: "Results vary.", confidence: "moderate", reviewState: "reviewed", supports: ["R/Evidence/E.md"], challenges: [], contextualizes: [], limitations: [] },
];
const snapshot = buildProjectSnapshot("R/Project.md", records, []);
const packet = buildDraftGrounding(snapshot, "R/Claims/C.md");
const section = parseDraftSections(renderDraftSection({ id: "c", claimPaths: [packet.claim.path], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [{ key: "smith", sourcePath: "R/Sources/S.md" }], provider: "anthropic", model: "old", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) }, "## C\n\nResults vary [@smith].")).sections[0]!;
const valid = JSON.stringify({ markdown: "## C\n\nThe results vary [@smith].", support: [{ passage: "The results vary [@smith].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/E.md"], citationKeys: ["smith"] }], claimPreservation: [{ claimPath: "R/Claims/C.md", passage: "The results vary [@smith].", status: "preserved" }], changes: [{ kind: "clarity", severity: "warning", description: "Uses direct wording." }], gaps: [] });

describe("RevisionCoordinator", () => {
  it("previews a current accepted section and records revision provenance without writing", async () => {
    const complete = vi.fn(async () => valid);
    const provider = { id: "anthropic", label: "Claude", hasCredentials: () => true, complete } as unknown as Provider;
    const coordinator = new RevisionCoordinator({ selection: () => ({ provider, model: "new-model" }), maxTokens: () => 2000, now: () => "now" });
    const preview = await coordinator.preview(snapshot, section, { intent: "clarity", customInstruction: "Use direct wording" });
    expect(preview.response.canAccept).toBe(true);
    expect(preview.envelope).toMatchObject({ provider: "anthropic", model: "new-model", revisionIntent: "clarity", revisionInstruction: "Use direct wording", revisedFromFingerprint: expect.stringMatching(/^fnv1a-/) });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ responseFormat: "json", temperature: 0 }));
  });

  it("retries once and fails closed without a generated fallback", async () => {
    const complete = vi.fn(async () => "{}");
    const provider = { id: "ollama", label: "Local", hasCredentials: () => true, complete } as unknown as Provider;
    const coordinator = new RevisionCoordinator({ selection: () => ({ provider, model: "local" }), maxTokens: () => 2000 });
    await expect(coordinator.preview(snapshot, section, { intent: "clarity" })).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("blocks revision of ready, edited, or grounding-stale sections before provider use", async () => {
    const complete = vi.fn();
    const provider = { id: "anthropic", label: "Claude", hasCredentials: () => true, complete } as unknown as Provider;
    const coordinator = new RevisionCoordinator({ selection: () => ({ provider, model: "m" }), maxTokens: () => 1000 });
    const ready = { ...section, envelope: { ...section.envelope, provider: "companion" } };
    const edited = { ...section, modifiedSinceReview: true };
    const stale = { ...section, envelope: { ...section.envelope, claimFingerprint: "old" } };
    await expect(coordinator.preview(snapshot, ready, { intent: "clarity" })).rejects.toThrow(/accepted section/i);
    await expect(coordinator.preview(snapshot, edited, { intent: "clarity" })).rejects.toThrow(/modified/i);
    await expect(coordinator.preview(snapshot, stale, { intent: "clarity" })).rejects.toThrow(/grounding changed/i);
    expect(complete).not.toHaveBeenCalled();
  });
});
