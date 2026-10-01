import { describe, expect, it } from "vitest";
import { buildExtractionRequest, fitSourceText, locatePassage, parseExtraction, resolveSourceText, type SourceTextIo } from "../../src/research/evidenceExtraction";

const reply = (...passages: Array<Record<string, string>>) => JSON.stringify({ passages });
const doc = { text: "# Intro\n\nOpening text here.\n\n## Findings\n\nThe study found a 12% drop.\n\nA second paragraph." };

describe("parseExtraction", () => {
  it("reads fenced JSON with prose around it", () => {
    const raw = `Here you go:\n\`\`\`json\n${reply({ title: "Drop", excerpt: "The study found a 12% drop.", interpretation: "It fell." })}\n\`\`\`\nDone.`;
    expect(parseExtraction(raw, doc, [])).toEqual([{ title: "Drop", excerpt: "The study found a 12% drop.", locatorKind: "section", locatorValue: "Findings", interpretation: "It fell." }]);
  });

  it("drops invented excerpts", () => {
    expect(parseExtraction(reply({ title: "X", excerpt: "Nothing like this exists." }), doc, [])).toEqual([]);
  });

  it("accepts whitespace and curly-quote variants and keeps the source wording", () => {
    const source = { text: "She said “it works”   and\nleft." };
    const out = parseExtraction(reply({ title: "Quote", excerpt: 'said "it works" and left.' }), source, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.excerpt).toBe("said “it works” and left.");
  });

  it("drops duplicates and passages already captured", () => {
    const raw = reply({ title: "A", excerpt: "The study found a 12% drop." }, { title: "B", excerpt: "The study  found a 12% drop." }, { title: "C", excerpt: "A second paragraph." });
    expect(parseExtraction(raw, doc, ["A second paragraph."]).map(({ title }) => title)).toEqual(["A"]);
  });

  it("locates by page for PDFs", () => {
    const source = { text: "One.\n\nTwo words here.", pages: [{ page: 1, text: "One." }, { page: 7, text: "Two words here." }] };
    expect(parseExtraction(reply({ title: "T", excerpt: "Two words here." }), source, [])[0]).toMatchObject({ locatorKind: "page", locatorValue: "7" });
  });

  it("falls back to the paragraph number without headings", () => {
    expect(locatePassage("Third one.", { text: "First.\n\nSecond.\n\nThird one." })).toEqual({ locatorKind: "paragraph", locatorValue: "3" });
  });

  it("trims long titles at a word and fills empty ones from the excerpt", () => {
    const long = "word ".repeat(30);
    const out = parseExtraction(reply({ title: long, excerpt: "The study found a 12% drop." }, { title: "", excerpt: "A second paragraph." }), doc, []);
    expect(out[0]!.title.length).toBeLessThanOrEqual(80);
    expect(out[0]!.title.endsWith("word")).toBe(true);
    expect(out[1]!.title).toBe("A second paragraph.");
  });

  it("returns nothing for unusable replies", () => {
    expect(parseExtraction("not json", doc, [])).toEqual([]);
  });
});

describe("fitSourceText", () => {
  it("leaves short text unchanged", () => {
    expect(fitSourceText("short", "q?")).toEqual({ text: "short", trimmed: false });
  });

  it("keeps question-relevant paragraphs in original order", () => {
    const text = ["alpha filler one", "glacier melt rates", "beta filler two", "glacier melt and permafrost", "gamma filler three"].join("\n\n");
    const out = fitSourceText(text, "How fast is glacier melt and permafrost loss?", 60);
    expect(out.trimmed).toBe(true);
    expect(out.text).toBe("glacier melt rates\n\nglacier melt and permafrost");
  });
});

describe("buildExtractionRequest", () => {
  it("carries the question, title, text, and a trimmed note", () => {
    const { system, user } = buildExtractionRequest({ question: "Why?", sourceTitle: "Doc", text: "Body", trimmed: true });
    expect(system).toContain('"passages"');
    expect(user).toContain("Why?");
    expect(user).toContain("Doc");
    expect(user).toContain("Body");
    expect(user).toContain("only its most relevant parts");
  });
});

describe("resolveSourceText", () => {
  const io = (over: Partial<SourceTextIo> = {}): SourceTextIo => ({ readPdfPages: async () => null, readNote: async () => null, ...over });

  it("prefers the captured text", async () => {
    expect(await resolveSourceText({ path: "S.md", capturedContent: "Captured." }, io({ readNote: async () => "body" }))).toEqual({ text: "Captured." });
  });

  it("reads PDF pages for a PDF asset", async () => {
    const pages = [{ page: 1, text: "One" }, { page: 2, text: "Two" }];
    expect(await resolveSourceText({ path: "S.md", asset: "a/Paper.PDF" }, io({ readPdfPages: async () => pages }))).toEqual({ text: "One\n\nTwo", pages });
  });

  it("falls back to the source note body without frontmatter", async () => {
    expect(await resolveSourceText({ path: "S.md" }, io({ readNote: async () => "---\ntitle: S\n---\n# Source\n\nCaptured study.\n" }))).toEqual({ text: "# Source\n\nCaptured study." });
  });

  it("returns null when nothing has text", async () => {
    expect(await resolveSourceText({ path: "S.md", asset: "a/Paper.pdf" }, io({ readNote: async () => "---\ntitle: S\n---\n" }))).toBeNull();
  });
});
