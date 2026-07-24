import { describe, it, expect } from "vitest";
import { frontmatterSuggestSystem, parseFrontmatterSuggestion } from "../src/indexing/frontmatterSuggest";

describe("frontmatterSuggestSystem", () => {
  it("offers the type list when ontology types exist", () => {
    const s = frontmatterSuggestSystem(["note", "project", "person"]);
    expect(s).toContain("note, project, person");
    expect(s).toContain("TAGS:");
    expect(s).toContain("SUMMARY:");
  });
  it("makes the type line a no-op when there are no types", () => {
    expect(frontmatterSuggestSystem([])).toContain("TYPE: -");
  });
});

describe("parseFrontmatterSuggestion", () => {
  it("parses TYPE / TAGS / SUMMARY and normalizes tags", () => {
    const r = parseFrontmatterSuggestion("TYPE: project\nTAGS: AI, Local Models, #inference\nSUMMARY: A note about running models locally.");
    expect(r.type).toBe("project");
    expect(r.tags).toEqual(["ai", "local-models", "inference"]);
    expect(r.summary).toBe("A note about running models locally.");
  });
  it("drops the type when the model returns '-'", () => {
    const r = parseFrontmatterSuggestion("TYPE: -\nTAGS: a, b\nSUMMARY: x");
    expect(r.type).toBeUndefined();
  });
  it("dedupes tags and tolerates surrounding prose", () => {
    const r = parseFrontmatterSuggestion("Here you go:\nTYPE: -\nTAGS: ai, ai, ml\nSUMMARY: y\nHope that helps");
    expect(r.tags).toEqual(["ai", "ml"]);
    expect(r.summary).toBe("y");
  });
  it("returns empty tags/summary when the reply is unusable", () => {
    const r = parseFrontmatterSuggestion("no structured fields here");
    expect(r.tags).toEqual([]);
    expect(r.summary).toBe("");
  });
});
