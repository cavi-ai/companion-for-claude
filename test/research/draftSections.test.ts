import { describe, expect, it } from "vitest";
import { fnv1aHex } from "../../src/hashing";
import {
  applyDraftSection,
  cleanModelMarkdown,
  containsReservedMarker,
  convertV1Document,
  normalizeSectionBody,
  parseDraftSections,
  renderManagedDocument,
  validateDocumentCitationKeys,
  type DraftSectionEnvelope,
} from "../../src/research/draftSections";

const drafted: DraftSectionEnvelope = {
  id: "claim-external-validity",
  claimPaths: ["Research/Claims/External validity.md"],
  evidence: [{ path: "Research/Evidence/Domain variation.md", fingerprint: "sha256:source-v1" }],
  citations: [{ key: "smith2025", sourcePath: "Research/Sources/Smith 2025.md" }],
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  generatedAt: "2026-07-14T20:00:00.000Z",
};
const outline = (id: string, claim: string): DraftSectionEnvelope => ({ id, claimPaths: [`Research/Claims/${claim}.md`], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" });

function v1Section(envelope: DraftSectionEnvelope, content: string, acceptedContent = content): string {
  const meta = encodeURIComponent(JSON.stringify(envelope));
  return `<!-- cavi:draft-section version=1 meta=${meta} fingerprint=fnv1a-${fnv1aHex(acceptedContent)} -->\n${content}\n<!-- cavi:draft-section:end id=${envelope.id} -->`;
}

describe("research document format v2", () => {
  it("round-trips clean prose with one provenance block at the end", () => {
    const doc = renderManagedDocument("# Draft", [{ envelope: drafted, heading: "External validity", markdown: "Performance varied by domain [@smith2025]." }]);
    expect(doc).not.toContain("cavi:draft-section");
    expect(doc).toContain("## External validity\n\nPerformance varied by domain [@smith2025].");
    expect(doc.split("```claude-provenance")[0]).not.toMatch(/claimPaths|fnv1a/);
    expect(doc.endsWith("```\n")).toBe(true);
    expect(parseDraftSections(doc)).toEqual({
      format: "v2",
      issues: [],
      sections: [{ envelope: drafted, heading: "External validity", markdown: "Performance varied by domain [@smith2025].", modifiedSinceReview: false }],
    });
  });

  it("flags a hand edit as modified since review", () => {
    const doc = renderManagedDocument("# Draft", [{ envelope: drafted, heading: "External validity", markdown: "Original [@smith2025]." }]);
    expect(parseDraftSections(doc.replace("Original", "Edited")).sections[0]?.modifiedSinceReview).toBe(true);
  });

  it("matches duplicate headings in order", () => {
    const doc = renderManagedDocument("", [
      { envelope: outline("same-a", "A"), heading: "Same", markdown: "first" },
      { envelope: outline("same-b", "B"), heading: "Same", markdown: "second" },
    ]);
    expect(parseDraftSections(doc).sections.map(({ markdown }) => markdown)).toEqual(["first", "second"]);
  });

  it("matches the managed section when a preamble heading has the same text", () => {
    const doc = renderManagedDocument("# Draft\n\n## Intro\n\nMy own intro.", [{ envelope: outline("intro", "Intro"), heading: "Intro", markdown: "Managed intro." }]);
    const parsed = parseDraftSections(doc);
    expect(parsed.issues).toEqual([]);
    expect(parsed.sections.map(({ markdown, modifiedSinceReview }) => [markdown, modifiedSinceReview])).toEqual([["Managed intro.", false]]);
  });

  it("reports a duplicate heading that cannot be told apart and refuses to accept", () => {
    const doc = renderManagedDocument("", [
      { envelope: outline("claim-a", "A"), heading: "A", markdown: "Body A." },
      { envelope: outline("claim-b", "B"), heading: "B", markdown: "Body B." },
    ]);
    const previewed = parseDraftSections(doc).sections[1]!;
    const inserted = doc.replace("Body A.", "Body A.\n\n## B\n\nMy own B.").replace("Body B.", "Body B edited.");
    expect(parseDraftSections(inserted).issues).toEqual(['Duplicate heading "B" — rename one so the section can be found']);
    expect(() => applyDraftSection(inserted, previewed, outline("claim-b", "B"), "New B.")).toThrow(/Duplicate heading "B"/);
  });

  it("reports a renamed heading", () => {
    const doc = renderManagedDocument("", [{ envelope: drafted, heading: "External validity", markdown: "Body [@smith2025]." }]);
    const parsed = parseDraftSections(doc.replace("## External validity", "## Renamed"));
    expect(parsed.sections).toEqual([]);
    expect(parsed.issues).toEqual(['Section "External validity" not found — restore the heading or rebuild the outline']);
  });

  it("reports unreadable JSON", () => {
    const doc = renderManagedDocument("", [{ envelope: drafted, heading: "External validity", markdown: "Body [@smith2025]." }]);
    const parsed = parseDraftSections(doc.replace('"version": 2', '"version": 2,,'));
    expect(parsed.format).toBe("v2");
    expect(parsed.issues[0]).toMatch(/^Provenance block is unreadable/);
  });

  it("reports more than one provenance block", () => {
    const doc = renderManagedDocument("", [{ envelope: drafted, heading: "External validity", markdown: "Body [@smith2025]." }]);
    expect(parseDraftSections(`${doc}\n${doc}`).issues).toEqual(["Document has more than one provenance block"]);
  });

  it("sanitizes headings", () => {
    const doc = renderManagedDocument("", [{ envelope: outline("c-sharp", "C"), heading: "C# vs.\nF#  ", markdown: "Body" }]);
    expect(doc).toContain("## C# vs. F#\n\nBody");
    expect(parseDraftSections(doc).sections[0]?.heading).toBe("C# vs. F#");
  });

  it("cleans model headings and leaves fenced code alone", () => {
    expect(cleanModelMarkdown("## Title\n\nIntro\n\n# Big\n\n## Sub\n\n```py\n# comment\n## not heading\n```\n\n### Keep"))
      .toBe("Intro\n\n### Big\n\n### Sub\n\n```py\n# comment\n## not heading\n```\n\n### Keep");
    expect(cleanModelMarkdown("## C\n\nText.\n\n# Big\n\n## Sub")).toBe("Text.\n\n### Big\n\n### Sub");
  });

  it("keeps user-authored first lines and h1 lines, demoting only h2", () => {
    expect(normalizeSectionBody("# of parameters predicts quality.\n\n## Sub\n\n# Big")).toBe("# of parameters predicts quality.\n\n### Sub\n\n# Big");
    const doc = renderManagedDocument("", [{ envelope: outline("c-a", "A"), heading: "A", markdown: "# of parameters predicts quality." }]);
    expect(parseDraftSections(doc).sections[0]).toMatchObject({ markdown: "# of parameters predicts quality.", modifiedSinceReview: false });
  });

  it("rejects reserved markers", () => {
    expect(containsReservedMarker("<!-- cavi:draft-section")).toBe(true);
    expect(containsReservedMarker("x\n```claude-provenance\n{}")).toBe(true);
    expect(() => normalizeSectionBody("text ```claude-provenance")).toThrow(/reserved Companion marker/);
  });

  it("applies an accepted draft and keeps section boundaries", () => {
    const doc = renderManagedDocument("# Draft", [
      { envelope: outline("claim-a", "Claim A"), heading: "Claim A", markdown: "Outline A." },
      { envelope: outline("claim-b", "Claim B"), heading: "Claim B", markdown: "Outline B." },
    ]);
    const previewed = parseDraftSections(doc).sections[0]!;
    const next = applyDraftSection(doc, previewed, { ...outline("claim-a", "Claim A"), provider: "anthropic", model: "m", generatedAt: "2026-10-01T00:00:00.000Z" }, "Drafted A.\n\n## Inner\n\nMore.");
    const parsed = parseDraftSections(next);
    expect(parsed.issues).toEqual([]);
    expect(parsed.sections.map(({ heading, markdown, modifiedSinceReview, envelope }) => ({ heading, markdown, modifiedSinceReview, provider: envelope.provider }))).toEqual([
      { heading: "Claim A", markdown: "Drafted A.\n\n### Inner\n\nMore.", modifiedSinceReview: false, provider: "anthropic" },
      { heading: "Claim B", markdown: "Outline B.", modifiedSinceReview: false, provider: "companion" },
    ]);
    expect(next.startsWith("# Draft\n\n## Claim A\n\nDrafted A.")).toBe(true);
  });

  it("refuses to apply when the section changed after preview", () => {
    const doc = renderManagedDocument("", [{ envelope: drafted, heading: "External validity", markdown: "Original [@smith2025]." }]);
    const previewed = parseDraftSections(doc).sections[0]!;
    expect(() => applyDraftSection(doc.replace("Original", "Edited"), previewed, drafted, "Replacement [@smith2025]."))
      .toThrow(/changed after the preview/i);
  });

  it("refuses an empty body and a mismatched id", () => {
    const doc = renderManagedDocument("", [{ envelope: drafted, heading: "External validity", markdown: "Original [@smith2025]." }]);
    const previewed = parseDraftSections(doc).sections[0]!;
    expect(() => applyDraftSection(doc, previewed, drafted, "  \n ")).toThrow(/must not be empty/);
    expect(() => applyDraftSection(doc, previewed, { ...drafted, id: "other" }, "Text [@smith2025].")).toThrow(/id must match/);
  });

  it("refuses a citation key that resolves to a different source", () => {
    const doc = renderManagedDocument("", [
      { envelope: outline("claim-a", "Claim A"), heading: "Claim A", markdown: "A" },
      { envelope: { ...drafted, id: "claim-b" }, heading: "Claim B", markdown: "B [@smith2025]." },
    ]);
    const previewed = parseDraftSections(doc).sections[0]!;
    const clash = { ...outline("claim-a", "Claim A"), provider: "anthropic", citations: [{ key: "smith2025", sourcePath: "Research/Sources/Other.md" }] };
    expect(() => applyDraftSection(doc, previewed, clash, "A [@smith2025].")).toThrow(/citation key collision.*smith2025/i);
  });

  it("rejects one citation key resolving to different sources across sections", () => {
    const other = { ...drafted, id: "other-section", citations: [{ key: "smith2025", sourcePath: "Research/Sources/Different.md" }] };
    expect(() => validateDocumentCitationKeys([drafted, other])).toThrow(/citation key collision.*smith2025/i);
  });
});

describe("CRLF documents", () => {
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");

  it("reads a CRLF v2 note with a multi-line section as unmodified", () => {
    const doc = renderManagedDocument("# Draft", [{ envelope: outline("c-a", "A"), heading: "A", markdown: "Line one.\nLine two.\n\nPara two." }]);
    expect(parseDraftSections(crlf(doc)).sections.map(({ markdown, modifiedSinceReview }) => [markdown, modifiedSinceReview])).toEqual([["Line one.\nLine two.\n\nPara two.", false]]);
  });

  it("reads and converts a CRLF v1 note", () => {
    const v1 = crlf(`# Outline\n\n${v1Section(outline("claim-a", "Claim A"), "## Claim A\n\nLine one.\nLine two.")}\n`);
    const parsed = parseDraftSections(v1);
    expect(parsed.sections.map(({ heading, markdown, modifiedSinceReview }) => [heading, markdown, modifiedSinceReview])).toEqual([["Claim A", "Line one.\nLine two.", false]]);
    const { document, converted } = convertV1Document(v1);
    expect(converted).toBe(1);
    expect(document).not.toContain("\r");
  });

  it("writes LF only after an accept", () => {
    const doc = crlf(renderManagedDocument("# Draft", [{ envelope: outline("c-a", "A"), heading: "A", markdown: "Old.\nMore." }]));
    const previewed = parseDraftSections(doc).sections[0]!;
    const next = applyDraftSection(doc, previewed, { ...outline("c-a", "A"), provider: "anthropic" }, "New.");
    expect(next).not.toContain("\r");
    expect(parseDraftSections(next).sections[0]).toMatchObject({ markdown: "New.", modifiedSinceReview: false });
  });
});

describe("old v1 documents", () => {
  const b = { ...drafted, id: "claim-b", claimPaths: ["Research/Claims/B claim.md"] };
  const v1 = `# Outline\n\n${v1Section(outline("claim-a", "Claim A"), "## Claim A\n\nProposition A.")}\n${v1Section(b, "Hand edited B [@smith2025].", "Drafted B [@smith2025].")}\n`;

  it("parses v1 sections with headings and modified status", () => {
    expect(parseDraftSections(v1)).toEqual({
      format: "v1",
      issues: [],
      sections: [
        { envelope: outline("claim-a", "Claim A"), heading: "Claim A", markdown: "Proposition A.", modifiedSinceReview: false },
        { envelope: b, heading: "B claim", markdown: "Hand edited B [@smith2025].", modifiedSinceReview: true },
      ],
    });
  });

  it("converts to v2 and keeps every status", () => {
    const { document, converted } = convertV1Document(v1);
    expect(converted).toBe(2);
    expect(document).not.toContain("cavi:draft-section");
    expect(document.startsWith("# Outline\n\n## Claim A\n\nProposition A.\n\n## B claim\n\nHand edited B [@smith2025].")).toBe(true);
    expect(parseDraftSections(document)).toEqual({
      format: "v2",
      issues: [],
      sections: [
        { envelope: outline("claim-a", "Claim A"), heading: "Claim A", markdown: "Proposition A.", modifiedSinceReview: false },
        { envelope: b, heading: "B claim", markdown: "Hand edited B [@smith2025].", modifiedSinceReview: true },
      ],
    });
  });

  it("converts before applying an accepted draft", () => {
    const previewed = parseDraftSections(v1).sections[0]!;
    const next = applyDraftSection(v1, previewed, { ...outline("claim-a", "Claim A"), provider: "anthropic", model: "m" }, "New A.");
    const parsed = parseDraftSections(next);
    expect(next).not.toContain("cavi:draft-section");
    expect(parsed.sections.map(({ markdown, modifiedSinceReview }) => [markdown, modifiedSinceReview])).toEqual([["New A.", false], ["Hand edited B [@smith2025].", true]]);
  });

  describe("prose outside managed sections", () => {
    const a = outline("claim-a", "Claim A");
    const stray = `# Outline\n\n${v1Section(a, "## Claim A\n\nProposition A.")}\nMy note between.\n${v1Section(b, "Body B.")}\n\nMy closing note.\n`;

    it("names each section followed by stray prose and refuses to convert or apply", () => {
      const parsed = parseDraftSections(stray);
      expect(parsed.issues).toEqual([
        'Text after "Claim A" is outside a managed section — put it under its own ## heading, then clean up again',
        'Text after "B claim" is outside a managed section — put it under its own ## heading, then clean up again',
      ]);
      expect(() => convertV1Document(stray)).toThrow(/outside a managed section/);
      expect(() => applyDraftSection(stray, parsed.sections[0]!, a, "New A.")).toThrow(/outside a managed section/);
    });

    it("converts once the prose sits under its own headings and keeps it byte for byte", () => {
      const fixed = `# Outline\n\n${v1Section(a, "## Claim A\n\nProposition A.")}\n\n## Notes\n\nMy note between.\n\n${v1Section(b, "Body B.")}\n\n## Notes 2\n\nMy closing note.\n`;
      const { document } = convertV1Document(fixed);
      const parsed = parseDraftSections(document);
      expect(parsed.issues).toEqual([]);
      expect(parsed.sections.map(({ modifiedSinceReview }) => modifiedSinceReview)).toEqual([false, false]);
      const next = applyDraftSection(fixed, parsed.sections[1]!, b, "New B.");
      expect(next).toContain("## Notes\n\nMy note between.\n");
      expect(next).toContain("## Notes 2\n\nMy closing note.\n");
    });
  });

  it("refuses to convert a document that mixes formats", () => {
    const mixed = `${v1}\n${renderManagedDocument("", [{ envelope: drafted, heading: "X", markdown: "Y [@smith2025]." }])}`;
    expect(() => convertV1Document(mixed)).toThrow(/mixes old and new/);
    expect(parseDraftSections(mixed).issues).toEqual(["Document mixes old and new section markers"]);
  });
});
