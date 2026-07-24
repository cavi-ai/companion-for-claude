import { describe, expect, it } from "vitest";
import { candidateId } from "../../src/discovery/identity";

describe("discovery candidate identity", () => {
  it("prefers DOI, then arXiv, then OpenAlex identity", () => {
    expect(candidateId({ adapter: "openalex", externalId: "W1", title: "T", authors: [], doi: "https://doi.org/10.1/X" })).toBe("doi:10.1/x");
    expect(candidateId({ adapter: "arxiv", externalId: "2501.01234v3", title: "T", authors: [], arxivId: "2501.01234v3" })).toBe("arxiv:2501.01234");
    expect(candidateId({ adapter: "openalex", externalId: "W1", title: "T", authors: [] })).toBe("openalex:W1");
  });

  it("falls back to a normalized bibliographic fingerprint", () => {
    expect(candidateId({ adapter: "crossref", externalId: "record", title: " A Study! ", authors: ["Ada Lovelace"], published: "2025-02-01" }))
      .toBe("fingerprint:a study|2025|ada lovelace");
  });

  it("rejects candidates without a safe identity", () => {
    expect(() => candidateId({ adapter: "crossref", externalId: "record", title: "A Study", authors: [] }))
      .toThrow("Discovery candidate has no stable identity");
  });
});
