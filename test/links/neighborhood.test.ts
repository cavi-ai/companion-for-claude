import { describe, it, expect } from "vitest";
import { neighborhood } from "../../src/links/neighborhood";
import type { ResolvedType } from "../../src/ontology/types";

const LINKS: Record<string, Record<string, number>> = {
  "A.md": { "B.md": 1, "C.md": 2 },
  "B.md": { "A.md": 1 },
  "D.md": { "A.md": 3 },
};

const projectType = {
  name: "project",
  fields: [],
  relations: [
    { key: "works_on", target: "project", label: "works on" },
    { key: "mentors", target: "person", label: "mentors" },
  ],
} as unknown as ResolvedType;

describe("neighborhood", () => {
  it("collects outgoing and incoming links, sorted, excluding self", () => {
    const n = neighborhood(LINKS, "A.md");
    expect(n.outgoing).toEqual(["B.md", "C.md"]);
    expect(n.incoming).toEqual(["B.md", "D.md"]);
  });

  it("handles an orphan note", () => {
    const n = neighborhood(LINKS, "Z.md");
    expect(n).toEqual({ outgoing: [], incoming: [], relations: [] });
  });

  it("extracts typed relations from frontmatter via the note's type", () => {
    const n = neighborhood({}, "P.md", { type: "person", works_on: ["[[Project X]]", "Project Y"], mentors: "[[Alice|boss]]" }, projectType);
    expect(n.relations).toEqual([
      { key: "works_on", to: "Project X" },
      { key: "works_on", to: "Project Y" },
      { key: "mentors", to: "Alice" },
    ]);
  });

  it("no relations without a type or frontmatter", () => {
    expect(neighborhood({}, "P.md", { works_on: ["[[X]]"] }).relations).toEqual([]);
    expect(neighborhood({}, "P.md", undefined, projectType).relations).toEqual([]);
  });
});
