import { describe, expect, it } from "vitest";
import { describeOntology } from "../../src/ontology/describe";
import { resolveTypes } from "../../src/ontology/schema";
import { SEED_TYPES } from "../../src/ontology/seed";

const registry = () => resolveTypes(SEED_TYPES).resolved;

describe("describeOntology", () => {
  it("lists every type with its lineage, properties and relations", () => {
    const d = describeOntology(registry());
    expect(d.note).toBeUndefined();
    expect(d.types.map((t) => t.name).sort()).toEqual([...registry().keys()].sort());
    const person = d.types.find((t) => t.name === "person")!;
    expect(person.lineage[0]).toBe("person");
    expect(person.lineage[person.lineage.length - 1]).toBe("entity");
    expect(person.properties.every((p) => typeof p.key === "string" && typeof p.type === "string" && typeof p.required === "boolean")).toBe(true);
  });

  it("returns one type and its ancestors, self first", () => {
    const d = describeOntology(registry(), "person");
    expect(d.types.map((t) => t.name)).toEqual(registry().get("person")!.lineage);
  });

  it("names the available types for an unknown one", () => {
    const d = describeOntology(registry(), "dragon");
    expect(d.types).toEqual([]);
    expect(d.note).toMatch(/^Unknown type 'dragon'\. Available: /);
  });

  it("says so when nothing is seeded", () => {
    expect(describeOntology(new Map())).toEqual({ types: [], note: "No ontology is seeded." });
  });
});
