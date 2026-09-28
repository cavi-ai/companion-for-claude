import { describe, it, expect, vi } from "vitest";
import { capturedTextFromBody, researchSourceText, extractResearchSourceEnrichment } from "../../src/research/enrichSource";

const CAPTURED = "x".repeat(400);
const note = (overrides: { frontmatter?: string; captured?: string | null; abstract?: string } = {}): string => {
  const fm = overrides.frontmatter ?? `title: Test\ntype: research-source\nproject: "[[P/Project.md]]"${overrides.abstract ? `\nabstract: ${overrides.abstract}` : ""}`;
  const captured = overrides.captured === null ? "" : `\n## Captured content\n\n<!-- cavi:capture version=1 chars=${(overrides.captured ?? CAPTURED).length} -->\n${overrides.captured ?? CAPTURED}\n<!-- cavi:capture:end -->\n`;
  return `---\n${fm}\n---\n\n# Research source\n${captured}\n## Notes\n`;
};

describe("capturedTextFromBody", () => {
  it("returns the length-addressed capture payload", () => {
    expect(capturedTextFromBody(`pre\n<!-- cavi:capture version=1 chars=5 -->\nhello\n<!-- cavi:capture:end -->`)).toBe("hello");
  });

  it("returns null for missing or malformed blocks", () => {
    expect(capturedTextFromBody("no block here")).toBeNull();
    expect(capturedTextFromBody("<!-- cavi:capture version=1 chars=999 -->\nshort")).toBeNull();
  });
});

describe("researchSourceText", () => {
  it("prefers captured content over the abstract", () => {
    const text = researchSourceText(note({ abstract: "y".repeat(300) }));
    expect(text).toBe(CAPTURED);
  });

  it("falls back to the abstract when there is no capture block", () => {
    const abstract = "z".repeat(300);
    expect(researchSourceText(note({ captured: null, abstract }))).toBe(abstract);
  });

  it("returns null when neither capture nor abstract is long enough", () => {
    expect(researchSourceText(note({ captured: null }))).toBeNull();
    expect(researchSourceText(note({ captured: null, abstract: "too short" }))).toBeNull();
  });
});

describe("extractResearchSourceEnrichment", () => {
  const complete = (reply: string) => vi.fn(async () => reply);

  it("extracts summary, topics, and key claims", async () => {
    const completeFn = complete(JSON.stringify({ summary: "A paper about testing.", topics: ["testing", "qa"], key_claims: ["Tests help."] }));
    const result = await extractResearchSourceEnrichment({ content: note() }, { complete: completeFn });
    expect(result).toEqual({ summary: "A paper about testing.", topics: ["testing", "qa"], key_claims: ["Tests help."] });
  });

  it("skips notes that already carry a summary without a model call", async () => {
    const completeFn = complete("{}");
    const content = note({ frontmatter: 'title: Test\ntype: research-source\nproject: "[[P/Project.md]]"\nsummary: Already summarized.' });
    const result = await extractResearchSourceEnrichment({ content }, { complete: completeFn });
    expect(result).toBeNull();
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("skips notes with too little source text without a model call", async () => {
    const completeFn = complete("{}");
    const result = await extractResearchSourceEnrichment({ content: note({ captured: null }) }, { complete: completeFn });
    expect(result).toBeNull();
    expect(completeFn).not.toHaveBeenCalled();
  });

  it("throws when the model cannot produce a valid summary after repairs", async () => {
    const completeFn = complete(JSON.stringify({ summary: "", topics: null, key_claims: null }));
    await expect(extractResearchSourceEnrichment({ content: note() }, { complete: completeFn })).rejects.toThrow(/extraction failed/);
    expect(completeFn).toHaveBeenCalledTimes(3);
  });
});
