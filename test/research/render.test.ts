import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseResearchRecord } from "../../src/research/parse";
import { renderResearchRecord } from "../../src/research/render";
import type { ResearchRecord } from "../../src/research/types";

function parseRendered(path: string, markdown: string) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("rendered note lacks frontmatter");
  return parseResearchRecord({ path, frontmatter: parse(match[1] ?? ""), body: (match[2] ?? "").trim() });
}

const records: ResearchRecord[] = [
  { path: "Projects/P.md", title: "P", type: "research-project", project: "Projects/P", question: "What works?", audience: "Researchers", stage: "gather", status: "active" },
  { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P", sourceKind: "doi", canonicalId: "10.1/x", url: "https://example.test", asset: "Files/S.pdf", contentFingerprint: "sha256:abc", doi: "10.1/x", arxivId: "2501.01234", zoteroKey: "KEY1", authors: ["Ada Lovelace"], published: "2025-04-02", publication: "Journal of Tests", abstract: "Abstract text", openAccessUrl: "https://example.test/open.pdf", discoveryProvenance: [{ adapter: "openalex", externalId: "W1" }] },
  { path: "Evidence/E.md", title: "E", type: "evidence", project: "Projects/P", source: "Sources/S", sourceFingerprint: "sha256:abc", locatorKind: "page", locatorValue: "14", excerpt: "Measured effect.\nAcross cohorts.", interpretation: "Useful result.", reviewState: "reviewed", model: "claude" },
  { path: "Claims/C.md", title: "C", type: "claim", project: "Projects/P", proposition: "The effect generalizes.", confidence: "moderate", reviewState: "proposed", supports: ["Evidence/E1"], challenges: ["Evidence/E2"], contextualizes: ["Evidence/E3"], limitations: ["Small sample"] },
  { path: "Questions/Q.md", title: "Q", type: "research-question", project: "Projects/P", question: "Does it generalize?", status: "open", about: "Claims/C" },
  { path: "Documents/D.md", title: "D", type: "research-document", project: "Projects/P", documentKind: "outline", claims: ["Claims/C"] },
];

describe("renderResearchRecord", () => {
  it("treats legacy ambiguous and malformed encoded captures as explicitly untrusted", () => {
    const common = { title: "S", type: "research-source", project: "[[Projects/P]]", source_kind: "vault", content_fingerprint: "sha256:spoofed" };
    const legacy = parseResearchRecord({ path: "Sources/Legacy.md", frontmatter: common, body: "# Research source\n\n<!-- cavi:capture:start -->\nprefix <!-- cavi:capture:end --> suffix\n<!-- cavi:capture:end -->" });
    expect(legacy.record).toEqual(expect.objectContaining({ type: "research-source" }));
    expect(legacy.record).not.toHaveProperty("capturedContent");
    expect(legacy.issues).toContainEqual(expect.objectContaining({ code: "invalid-value", message: expect.stringContaining("Legacy unencoded") }));

    const malformed = parseResearchRecord({ path: "Sources/Malformed.md", frontmatter: common, body: "<!-- cavi:capture version=1 chars=9 -->\nshort\n<!-- cavi:capture:end -->" });
    expect(malformed.record).not.toHaveProperty("capturedContent");
    expect(malformed.issues).toContainEqual(expect.objectContaining({ code: "invalid-value", message: expect.stringContaining("Malformed length-addressed") }));

    for (const body of [
      "<!-- cavi:capture version=2 chars=3 -->\nraw\n<!-- cavi:capture:end -->",
      "<!-- cavi:capture version=1 chars=3 -->\nraw\n<!-- wrong:end -->",
      "<!-- cavi:capture version=1 chars=nope -->\nraw\n<!-- cavi:capture:end -->",
    ]) {
      const result = parseResearchRecord({ path: "Sources/Invalid.md", frontmatter: common, body });
      expect(result.record).not.toHaveProperty("capturedContent");
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
    }
  });

  it("uses canonical locator keys and quoted evidence excerpts", () => {
    const rendered = renderResearchRecord(records[2]!);
    expect(rendered).toContain('locator_kind: "page"');
    expect(rendered).toContain('source_fingerprint: "sha256:abc"');
    expect(rendered).toContain('locator_value: "14"');
    expect(rendered).not.toContain("locatorKind:");
    expect(rendered).toContain("> Measured effect.\n> Across cohorts.");
  });

  it.each(["0014", "1e3", "1.0"])("preserves exact locator text %s", (locatorValue) => {
    const evidence = { ...records[2]!, locatorValue };
    const rendered = renderResearchRecord(evidence);
    expect(rendered).toContain(`locator_value: ${JSON.stringify(locatorValue)}`);
    expect(parseRendered(evidence.path, rendered).record).toEqual(evidence);
  });

  it.each(records.map((record) => [record.type, record] as const))("round-trips %s records", (_type, record) => {
    const result = parseRendered(record.path, renderResearchRecord(record));
    expect(result.issues).toEqual([]);
    expect(result.record).toEqual(record);
  });

  it("anchors the evidence excerpt with a block reference", () => {
    const rendered = renderResearchRecord(records[2]!);
    expect(rendered).toContain("> Measured effect.\n> Across cohorts.\n\n^excerpt");
    // the anchor stays out of the parsed excerpt and interpretation
    const parsed = parseRendered(records[2]!.path, rendered);
    expect(parsed.record).toEqual(records[2]);
  });

  it("renders claim limitations as a callout and omits it when empty", () => {
    const rendered = renderResearchRecord(records[3]!);
    expect(rendered).toContain("> [!warning]- Limitations\n> - Small sample");
    expect(parseRendered(records[3]!.path, rendered).record).toEqual(records[3]);

    const unlimited = { ...records[3]!, limitations: [] };
    expect(renderResearchRecord(unlimited)).not.toContain("[!warning]");
  });

  it("persists canonical scholarly field names as snake_case", () => {
    const rendered = renderResearchRecord(records[1]!);
    expect(rendered).toContain('arxiv_id: "2501.01234"');
    expect(rendered).toContain('zotero_key: "KEY1"');
    expect(rendered).not.toContain("arxivId:");
    expect(rendered).not.toContain("zoteroKey:");
    expect(rendered).toContain('abstract: "Abstract text"');
    expect(rendered).toContain('open_access_url: "https://example.test/open.pdf"');
    expect(rendered).toContain("discovery_provenance:");
    expect(rendered).not.toContain("openAccessUrl:");
  });
});
