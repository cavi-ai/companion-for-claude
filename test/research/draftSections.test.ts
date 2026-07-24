import { describe, expect, it } from "vitest";
import {
  applyDraftSection,
  parseDraftSections,
  renderDraftSection,
  validateDocumentCitationKeys,
  type DraftSectionEnvelope,
} from "../../src/research/draftSections";

const envelope: DraftSectionEnvelope = {
  id: "claim-external-validity",
  claimPaths: ["Research/Claims/External validity.md"],
  evidence: [{ path: "Research/Evidence/Domain variation.md", fingerprint: "sha256:source-v1" }],
  citations: [{ key: "smith2025", sourcePath: "Research/Sources/Smith 2025.md" }],
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  generatedAt: "2026-07-14T20:00:00.000Z",
};

describe("managed research draft sections", () => {
  it("round-trips readable Markdown with an inspectable provenance envelope", () => {
    const rendered = renderDraftSection(envelope, "Performance varied by domain [@smith2025].");

    const parsed = parseDraftSections(`# Draft\n\n${rendered}\n`);

    expect(parsed.issues).toEqual([]);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]).toMatchObject({
      envelope,
      markdown: "Performance varied by domain [@smith2025].",
      modifiedSinceReview: false,
    });
    expect(rendered).toContain("Performance varied by domain [@smith2025].");
  });

  it("refuses to replace a section when the document changed after preview", () => {
    const original = `# Draft\n\n${renderDraftSection(envelope, "Original [@smith2025].")}\n`;
    const preview = parseDraftSections(original).sections[0];
    if (!preview) throw new Error("fixture section missing");
    const edited = original.replace("Original", "Manually edited");

    expect(() => applyDraftSection(edited, preview, envelope, "Replacement [@smith2025]."))
      .toThrow(/changed after the preview/i);
  });

  it("applies a body-only preview to the same unique section in a full frontmatter document", () => {
    const body = `# Draft\n\n${renderDraftSection(envelope, "Original [@smith2025].")}\n`;
    const preview = parseDraftSections(body).sections[0];
    if (!preview) throw new Error("fixture section missing");
    const full = `---\ntype: research-document\ndocument_kind: outline\n---\n${body}`;

    expect(applyDraftSection(full, preview, envelope, "Replacement [@smith2025].")).toContain("Replacement [@smith2025].");
  });

  it("rejects one citation key resolving to different sources across document sections", () => {
    const other = { ...envelope, id: "other-section", citations: [{ key: "smith2025", sourcePath: "Research/Sources/Different.md" }] };
    expect(() => validateDocumentCitationKeys([envelope, other])).toThrow(/citation key collision.*smith2025/i);
  });
});
