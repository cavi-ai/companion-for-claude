import { describe, expect, it } from "vitest";
import { describeFilter, hitMetadata, matchesSearchFilter, normalizeProjectRef, parseSearchFilter } from "../../src/context/searchFilter";

describe("parseSearchFilter", () => {
  it("returns null when no filter is set and strips a leading # from tag", () => {
    expect(parseSearchFilter({ query: "x" })).toBeNull();
    expect(parseSearchFilter({ type: "  ", project: "" })).toBeNull();
    expect(parseSearchFilter({ type: "research-evidence", tag: "#ml" })).toEqual({ type: "research-evidence", tag: "ml" });
  });
});

describe("normalizeProjectRef", () => {
  it("strips wikilink brackets, alias and .md, lowercases", () => {
    expect(normalizeProjectRef("[[Research/Alpha/Project.md]]")).toBe("research/alpha/project");
    expect(normalizeProjectRef("[[Research/Alpha/Project|Alpha]]")).toBe("research/alpha/project");
    expect(normalizeProjectRef("Alpha")).toBe("alpha");
  });
});

describe("matchesSearchFilter", () => {
  const alpha = { type: "research-evidence", project: "[[Research/Alpha/Project.md]]" };
  const beta = { type: "research-evidence", project: "[[Research/Beta/Project.md]]" };
  it("matches type exactly", () => {
    expect(matchesSearchFilter(alpha, [], { type: "research-evidence" })).toBe(true);
    expect(matchesSearchFilter(alpha, [], { type: "Research-Evidence" })).toBe(false);
    expect(matchesSearchFilter(undefined, [], { type: "research-evidence" })).toBe(false);
  });
  it("matches project by full path or path suffix, never another project's Project.md", () => {
    expect(matchesSearchFilter(alpha, [], { project: "Research/Alpha/Project.md" })).toBe(true);
    expect(matchesSearchFilter(alpha, [], { project: "Alpha/Project" })).toBe(true);
    expect(matchesSearchFilter(beta, [], { project: "Alpha/Project" })).toBe(false);
    expect(matchesSearchFilter({ project: "Alpha" }, [], { project: "alpha" })).toBe(true);
    expect(matchesSearchFilter({ project: ["[[A]]"] }, [], { project: "A" })).toBe(true);
  });
  it("matches the bare project name (folder), not just the full Project.md path", () => {
    expect(matchesSearchFilter(alpha, [], { project: "Alpha" })).toBe(true);
    expect(matchesSearchFilter(alpha, [], { project: "Research/Alpha" })).toBe(true);
    expect(matchesSearchFilter(beta, [], { project: "Alpha" })).toBe(false);
    expect(matchesSearchFilter(beta, [], { project: "Research/Alpha" })).toBe(false);
    expect(matchesSearchFilter(alpha, [], { project: "Alpha/Project" })).toBe(true);
    expect(matchesSearchFilter(alpha, [], { project: "lpha" })).toBe(false);
  });
  it("matches list-valued type/project by any element, including nested arrays", () => {
    expect(matchesSearchFilter({ project: ["[[Research/Alpha/Project.md]]", "[[X]]"] }, [], { project: "Alpha/Project" })).toBe(true);
    expect(matchesSearchFilter({ project: [["Alpha"]] }, [], { project: "Alpha" })).toBe(true);
    expect(matchesSearchFilter({ type: ["note", "research-evidence"] }, [], { type: "research-evidence" })).toBe(true);
  });
  it("matches a tag exactly or as a nested parent", () => {
    expect(matchesSearchFilter(undefined, ["#ml/vision"], { tag: "ml" })).toBe(true);
    expect(matchesSearchFilter(undefined, ["#ml"], { tag: "ML" })).toBe(true);
    expect(matchesSearchFilter(undefined, ["#mlops"], { tag: "ml" })).toBe(false);
  });
  it("requires every set field", () => {
    expect(matchesSearchFilter(alpha, ["#x"], { type: "research-evidence", tag: "y" })).toBe(false);
  });
});

describe("hitMetadata / describeFilter", () => {
  it("prints only present provenance fields in fixed order", () => {
    expect(hitMetadata({ url: "https://x.test", type: "research-source", title: "T", review_state: "reviewed" })).toBe("type: research-source · review_state: reviewed · url: https://x.test");
    expect(hitMetadata({ title: "only" })).toBe("");
    expect(hitMetadata(undefined)).toBe("");
  });
  it("collapses multi-line values and joins list-valued fields", () => {
    expect(hitMetadata({ url: "https://a\nb" })).toBe("url: https://a b");
    expect(hitMetadata({ project: ["[[A]]", "[[B]]"] })).toBe("project: [[A]], [[B]]");
  });
  it("names active filters", () => {
    expect(describeFilter({ type: "evidence", tag: "ml" })).toBe("type: evidence, tag: ml");
  });
});
