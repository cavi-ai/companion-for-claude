import { describe, it, expect } from "vitest";
import { ontologyDigest } from "../../src/ontology/digest";
import type { ResolvedType } from "../../src/ontology/types";

const person: ResolvedType = {
  name: "person", version: 1, lineage: ["person", "entity"],
  properties: [
    { key: "role", type: "string", required: true },
    { key: "age", type: "number", required: false },
  ],
  relations: [{ key: "works_on", targets: ["project"] }],
};
const entity: ResolvedType = { name: "entity", version: 1, lineage: ["entity"], properties: [], relations: [] };

describe("ontologyDigest", () => {
  it("renders one compact line per type, required props unmarked, optional with ?", () => {
    const d = ontologyDigest([entity, person]);
    expect(d).toContain("- person: role (string), age? (number); relations: works_on → project");
    expect(d).toContain("- entity");
  });
  it("explains the frontmatter convention in the header", () => {
    const d = ontologyDigest([person]);
    expect(d).toMatch(/type/);
    expect(d).toMatch(/wikilink/);
  });
  it("returns empty string for an empty ontology", () => {
    expect(ontologyDigest([])).toBe("");
  });
  it("multi-target relations join with |", () => {
    const t: ResolvedType = { ...entity, name: "meeting", relations: [{ key: "about", targets: ["project", "person"] }] };
    expect(ontologyDigest([t])).toContain("about → project|person");
  });
});
