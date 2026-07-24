import { describe, expect, it, vi } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { DraftCoordinator } from "../../src/research/draftCoordinator";
import { renderDraftSection, parseDraftSections } from "../../src/research/draftSections";
import type { Provider } from "../../src/providers/types";
import type { ResearchRecord } from "../../src/research/types";

const records: ResearchRecord[] = [
  { path: "R/Project.md", title: "R", type: "research-project", project: "R/Project.md", question: "Why?", stage: "shape", status: "active" },
  { path: "R/Sources/S.md", title: "S", type: "research-source", project: "R/Project.md", sourceKind: "zotero", zoteroKey: "smith2025", contentFingerprint: "sha256:s" },
  { path: "R/Evidence/E.md", title: "E", type: "evidence", project: "R/Project.md", source: "R/Sources/S.md", sourceFingerprint: "sha256:s", locatorKind: "page", locatorValue: "14", excerpt: "Results varied.", reviewState: "reviewed" },
  { path: "R/Claims/C.md", title: "C", type: "claim", project: "R/Project.md", proposition: "Results vary.", confidence: "moderate", reviewState: "reviewed", supports: ["R/Evidence/E.md"], challenges: [], contextualizes: [], limitations: [] },
];

describe("DraftCoordinator", () => {
  it("returns a validated preview with provider provenance and performs no vault write", async () => {
    const complete = vi.fn(async () => JSON.stringify({
      markdown: "Results vary [@smith2025].",
      support: [{ passage: "Results vary [@smith2025].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/E.md"], citationKeys: ["smith2025"] }],
      gaps: [],
    }));
    const provider = { id: "anthropic", label: "Claude", hasCredentials: () => true, complete } as unknown as Provider;
    const coordinator = new DraftCoordinator({ selection: () => ({ provider, model: "claude-test" }), maxTokens: () => 2000, now: () => "2026-07-14T20:00:00.000Z" });
    const section = parseDraftSections(renderDraftSection({ id: "c-1", claimPaths: ["R/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, "## C\n\nResults vary.")).sections[0];
    if (!section) throw new Error("missing section");

    const preview = await coordinator.preview(buildProjectSnapshot("R/Project.md", records, []), section);

    expect(preview.response.markdown).toBe("Results vary [@smith2025].");
    expect(preview.envelope).toMatchObject({ id: "c-1", provider: "anthropic", model: "claude-test", generatedAt: "2026-07-14T20:00:00.000Z" });
    expect(preview.envelope.evidence).toEqual([{ path: "R/Evidence/E.md", fingerprint: expect.stringMatching(/^fnv1a-/) }]);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-test", temperature: 0, maxTokens: 2000, responseFormat: "json", responseSchema: expect.objectContaining({ type: "object" }) }));
  });

  it("retries one malformed structured response with validation feedback", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ markdown: "", support: [], gaps: [] }))
      .mockResolvedValueOnce(JSON.stringify({
        markdown: "Results vary [@smith2025].",
        support: [{ passage: "Results vary [@smith2025].", claimPath: "R/Claims/C.md", evidencePaths: ["R/Evidence/E.md"], citationKeys: ["smith2025"] }],
        gaps: [],
      }));
    const provider = { id: "ollama", label: "Local", hasCredentials: () => true, complete } as unknown as Provider;
    const coordinator = new DraftCoordinator({ selection: () => ({ provider, model: "local-test" }), maxTokens: () => 2000 });
    const section = parseDraftSections(renderDraftSection({ id: "c-1", claimPaths: ["R/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, "## C")).sections[0];
    if (!section) throw new Error("missing section");

    const preview = await coordinator.preview(buildProjectSnapshot("R/Project.md", records, []), section);

    expect(preview.response.markdown).toContain("[@smith2025]");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toMatch(/Markdown must not be empty/i);
  });

  it("returns a minimal cited fallback when both model responses fail validation", async () => {
    const complete = vi.fn(async () => JSON.stringify({ markdown: "Ungrounded prose", support: [], gaps: [] }));
    const provider = { id: "ollama", label: "Local", hasCredentials: () => true, complete } as unknown as Provider;
    const coordinator = new DraftCoordinator({ selection: () => ({ provider, model: "local-test" }), maxTokens: () => 2000 });
    const section = parseDraftSections(renderDraftSection({ id: "c-1", claimPaths: ["R/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, "## Findings\n\nPlaceholder.")).sections[0];
    if (!section) throw new Error("missing section");

    const preview = await coordinator.preview(buildProjectSnapshot("R/Project.md", records, []), section);

    expect(preview.response.markdown).toBe("## Findings\n\nResults vary. [@smith2025]");
    expect(preview.response.support[0]).toEqual(expect.objectContaining({ passage: "Results vary. [@smith2025]", evidencePaths: ["R/Evidence/E.md"] }));
    expect(preview.response.gaps[0]).toMatch(/minimal reviewed-claim fallback/i);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("fails before calling a provider when credentials are unavailable", async () => {
    const complete = vi.fn();
    const provider = { id: "anthropic", label: "Claude", hasCredentials: () => false, complete } as unknown as Provider;
    const coordinator = new DraftCoordinator({ selection: () => ({ provider, model: "claude-test" }), maxTokens: () => 2000 });
    const section = parseDraftSections(renderDraftSection({ id: "c-1", claimPaths: ["R/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, "## C")).sections[0];
    if (!section) throw new Error("missing section");
    await expect(coordinator.preview(buildProjectSnapshot("R/Project.md", records, []), section)).rejects.toThrow(/credential/i);
    expect(complete).not.toHaveBeenCalled();
  });
});
