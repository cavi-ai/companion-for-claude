import { describe, it, expect } from "vitest";
import { formatWikilink, parseWikilink, relationTargets, extractEdges } from "../../src/ontology/relations";
import type { ResolvedType } from "../../src/ontology/types";

describe("wikilink parse/format", () => {
  it("round-trips", () => {
    expect(formatWikilink("CAVI")).toBe("[[CAVI]]");
    expect(parseWikilink("[[CAVI]]")).toBe("CAVI");
  });
  it("takes the target before an alias pipe", () => {
    expect(parseWikilink("[[Projects/CAVI|the project]]")).toBe("Projects/CAVI");
  });
  it("accepts a bare string as a target name", () => {
    expect(parseWikilink("CAVI")).toBe("CAVI");
  });
  it("rejects empty values", () => {
    expect(parseWikilink("")).toBeNull();
    expect(parseWikilink("[[]]")).toBeNull();
  });
  it("rejects bracket debris instead of extracting garbage targets", () => {
    expect(parseWikilink("see [[A]] and [[B]]")).toBeNull();
    expect(parseWikilink("![[A]]")).toBeNull();
    expect(parseWikilink("see [[A]]")).toBeNull();
    expect(parseWikilink("[[a|b]] extra")).toBeNull();
  });
  it("strips #heading and ^block subpath suffixes", () => {
    expect(parseWikilink("[[A#h]]")).toBe("A");
    expect(parseWikilink("[[A^b]]")).toBe("A");
  });
  it("still passes a plain bare target through", () => {
    expect(parseWikilink("CAVI")).toBe("CAVI");
  });
});

describe("relationTargets", () => {
  it("normalizes scalar and list values", () => {
    expect(relationTargets("[[A]]")).toEqual(["A"]);
    expect(relationTargets(["[[A]]", "[[B|b]]", "C"])).toEqual(["A", "B", "C"]);
  });
  it("ignores non-strings", () => {
    expect(relationTargets([1, null, "[[A]]"])).toEqual(["A"]);
    expect(relationTargets(undefined)).toEqual([]);
  });
});

describe("extractEdges", () => {
  const person: ResolvedType = {
    name: "person",
    version: 1,
    lineage: ["person", "entity"],
    properties: [],
    relations: [
      { key: "works_on", targets: ["project"] },
      { key: "knows", targets: ["person"] },
    ],
  };
  it("extracts typed edges from relation fields only", () => {
    const fm = { type: "person", works_on: ["[[CAVI]]"], knows: "[[Ada]]", title: "Franco" };
    expect(extractEdges("People/Franco.md", fm, person)).toEqual([
      { from: "People/Franco.md", key: "works_on", to: "CAVI" },
      { from: "People/Franco.md", key: "knows", to: "Ada" },
    ]);
  });
  it("returns [] when the note has no relation fields", () => {
    expect(extractEdges("x.md", { type: "person" }, person)).toEqual([]);
  });
});
