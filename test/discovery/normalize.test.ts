import { describe, expect, it } from "vitest";
import { mergeAdapterWorks } from "../../src/discovery/normalize";
import type { ResearchSourceRecord } from "../../src/research/types";

function source(path: string, fields: Partial<ResearchSourceRecord> = {}): ResearchSourceRecord {
  return {
    path,
    title: "Existing source",
    type: "research-source",
    project: "P/Project.md",
    sourceKind: "doi",
    ...fields,
  };
}

describe("discovery candidate normalization", () => {
  it("retains field provenance and exposes adapter disagreement", () => {
    const candidate = mergeAdapterWorks([
      { adapter: "openalex", externalId: "W1", openAlexId: "W1", doi: "10.1/x", title: "Open title", authors: ["Ada"], published: "2025" },
      { adapter: "crossref", externalId: "10.1/x", doi: "10.1/x", title: "Crossref title", authors: ["Ada"], published: "2025" },
    ], [source("Sources/Existing.md", { doi: "10.1/x" })]);
    expect(candidate.id).toBe("doi:10.1/x");
    expect(candidate.provenance.title).toHaveLength(2);
    expect(candidate.disagreements.map(({ field }) => field)).toContain("title");
    expect(candidate.existingSourcePath).toBe("Sources/Existing.md");
  });

  it("never merges works with conflicting stable identifiers", () => {
    expect(() => mergeAdapterWorks([
      { adapter: "openalex", externalId: "W1", doi: "10.1/a", title: "Same", authors: ["Ada"], published: "2025" },
      { adapter: "crossref", externalId: "10.1/b", doi: "10.1/b", title: "Same", authors: ["Ada"], published: "2025" },
    ], [])).toThrow(/conflicting stable identifiers/i);
  });

  it("uses Crossref bibliographic metadata without treating normalized DOI forms as disagreement", () => {
    const candidate = mergeAdapterWorks([
      { adapter: "openalex", externalId: "W1", doi: "https://doi.org/10.1/X", title: "Open title", authors: ["Open Author"] },
      { adapter: "crossref", externalId: "10.1/x", doi: "doi:10.1/x", title: "Crossref title", authors: ["Crossref Author"] },
    ], []);
    expect(candidate).toMatchObject({ doi: "10.1/x", title: "Crossref title", authors: ["Crossref Author"] });
    expect(candidate.disagreements.map(({ field }) => field)).not.toContain("doi");
  });

  it("retains an OpenAlex adapter external ID regardless of adapter order", () => {
    const candidate = mergeAdapterWorks([
      { adapter: "crossref", externalId: "record", title: "Shared", authors: ["Ada"], published: "2025" },
      { adapter: "openalex", externalId: "W42", title: "Shared", authors: ["Ada"], published: "2025" },
    ], []);
    expect(candidate).toMatchObject({ id: "openalex:W42", openAlexId: "W42" });
  });
});
