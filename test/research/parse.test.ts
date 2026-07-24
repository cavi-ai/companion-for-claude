import { describe, expect, it } from "vitest";
import { parseResearchCandidate, parseResearchRecord } from "../../src/research/parse";

describe("parseResearchRecord", () => {
  it("explains invalid types for canonical scoped candidates without flagging ordinary broad-scan notes", () => {
    const input = { path: "P/Evidence/Damaged.md", frontmatter: { type: "ordinary-note" }, body: "" };
    expect(parseResearchRecord(input).issues).toEqual([]);
    expect(parseResearchCandidate(input).issues).toEqual([{ path: input.path, code: "unknown-type", message: "Unknown research type: ordinary-note" }]);
  });
  it("parses reviewed evidence with a page locator", () => {
    const result = parseResearchRecord({
      path: "Research/Evidence/E1.md",
      frontmatter: {
        title: "E1",
        type: "evidence",
        project: "[[Project]]",
        source: "[[Paper]]",
        source_fingerprint: "sha256:captured",
        locator_kind: "page",
        locator_value: "14",
        review_state: "reviewed",
      },
      body: "> Performance varied by domain.\n\nInterpretation: external validity is limited.",
    });

    expect(result.record).toMatchObject({
      type: "evidence",
      project: "Project",
      source: "Paper",
      sourceFingerprint: "sha256:captured",
      excerpt: "Performance varied by domain.",
      interpretation: "external validity is limited.",
      reviewState: "reviewed",
      locatorKind: "page",
      locatorValue: "14",
    });
    expect(result.issues).toEqual([]);
  });

  it("keeps missing-locator evidence but reports it", () => {
    const result = parseResearchRecord({
      path: "E.md",
      frontmatter: { title: "E", type: "evidence", project: "[[P]]", source: "[[S]]", review_state: "proposed" },
      body: "> excerpt",
    });

    expect(result.record?.type).toBe("evidence");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-locator");
  });

  it("omits records without their identity field", () => {
    const result = parseResearchRecord({
      path: "Claim.md",
      frontmatter: { title: "Claim", type: "claim", project: "[[P]]", confidence: "certain", review_state: "reviewed" },
      body: "",
    });

    expect(result.record).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["missing-field", "invalid-value"]));
  });

  it("normalizes valid wikilinks and reports malformed singular and array relations", () => {
    const valid = parseResearchRecord({
      path: "Claim.md",
      frontmatter: {
        title: "Claim",
        type: "claim",
        project: "[[Projects/P|Project]]",
        proposition: "P",
        confidence: "high",
        review_state: "reviewed",
        supports: ["[[Evidence/E1|E1]]"],
        challenges: ["not-a-link"],
        contextualizes: [],
      },
      body: "",
    });

    expect(valid.record).toMatchObject({ project: "Projects/P", supports: ["Evidence/E1"], challenges: [] });
    expect(valid.issues).toEqual([expect.objectContaining({ code: "invalid-value" })]);

    const malformed = parseResearchRecord({
      path: "E.md",
      frontmatter: { title: "E", type: "evidence", project: "P", source: "[[S]]", review_state: "reviewed" },
      body: "> excerpt",
    });
    expect(malformed.record).toBeUndefined();
    expect(malformed.issues.map((entry) => entry.code)).toContain("invalid-value");
  });

  it("retains valid relation links beside malformed array entries", () => {
    const result = parseResearchRecord({
      path: "Claim.md",
      frontmatter: {
        title: "Claim",
        type: "claim",
        project: "[[Projects/P]]",
        proposition: "P",
        confidence: "high",
        review_state: "reviewed",
        supports: ["[[Evidence/E1]]", 42, "bad"],
      },
      body: "",
    });

    expect(result.record).toMatchObject({ supports: ["Evidence/E1"] });
    expect(result.issues.filter((entry) => entry.code === "invalid-value")).toHaveLength(2);
  });

  it("uses deterministic fallbacks for malformed mandatory enums", () => {
    const project = parseResearchRecord({
      path: "P.md",
      frontmatter: { title: "P", type: "research-project", project: "[[P]]", question: "Q?", stage: "bogus", status: "bogus" },
      body: "",
    });
    expect(project.record).toMatchObject({ stage: "frame", status: "active" });

    const question = parseResearchRecord({
      path: "Q.md",
      frontmatter: { title: "Q", type: "research-question", project: "[[P]]", question: "Q?", status: "bogus" },
      body: "",
    });
    expect(question.record).toMatchObject({ status: "open" });

    const claim = parseResearchRecord({
      path: "C.md",
      frontmatter: { title: "C", type: "claim", project: "[[P]]", proposition: "P", confidence: "bogus", review_state: "bogus" },
      body: "",
    });
    expect(claim.record).toMatchObject({ confidence: "moderate", reviewState: "proposed" });
    expect([...project.issues, ...question.issues, ...claim.issues].every((entry) => entry.code === "invalid-value")).toBe(true);
  });

  it("validates source, asset, about, and claims wikilinks", () => {
    const evidence = parseResearchRecord({
      path: "E.md",
      frontmatter: { title: "E", type: "evidence", project: "[[P]]", source: "S", review_state: "reviewed" },
      body: "> excerpt",
    });
    expect(evidence.record).toBeUndefined();

    const source = parseResearchRecord({
      path: "S.md",
      frontmatter: { title: "S", type: "research-source", project: "[[P]]", source_kind: "pdf", asset: "file.pdf" },
      body: "",
    });
    expect(source.record).toMatchObject({ type: "research-source" });
    expect(source.record).not.toHaveProperty("asset");

    const question = parseResearchRecord({
      path: "Q.md",
      frontmatter: { title: "Q", type: "research-question", project: "[[P]]", question: "Q?", status: "open", about: "C" },
      body: "",
    });
    expect(question.record).not.toHaveProperty("about");

    const document = parseResearchRecord({
      path: "D.md",
      frontmatter: { title: "D", type: "research-document", project: "[[P]]", document_kind: "outline", claims: ["C"] },
      body: "",
    });
    expect(document.record).toMatchObject({ claims: [] });
    expect([evidence, source, question, document].every((result) => result.issues.some((entry) => entry.code === "invalid-value"))).toBe(true);
  });

  it("ignores non-research notes and unknown types without throwing", () => {
    expect(parseResearchRecord({ path: "Note.md", body: "plain" })).toEqual({ issues: [] });
    expect(parseResearchRecord({ path: "Odd.md", frontmatter: { type: "odd" }, body: "" })).toEqual({ issues: [] });
  });

  it("reports and excludes malformed discovery provenance entries", () => {
    const result = parseResearchRecord({
      path: "S.md",
      frontmatter: {
        title: "S", type: "research-source", project: "[[P]]", source_kind: "doi",
        discovery_provenance: [
          { adapter: "openalex", external_id: "W1" },
          { adapter: "semantic-scholar", external_id: "S1" },
          { adapter: "crossref", external_id: "" },
          "arbitrary",
        ],
      },
      body: "",
    });
    expect(result.record).toMatchObject({ discoveryProvenance: [{ adapter: "openalex", externalId: "W1" }] });
    expect(result.issues.filter(({ code }) => code === "invalid-value")).toHaveLength(3);
  });
});
