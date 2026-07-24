import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { extractYamlBlock, parseSchemaNote, resolveTypes } from "../../src/ontology/schema";
import type { TypeDef } from "../../src/ontology/types";

const FM = { ontology: "type", type_name: "person", version: 1 };

const BODY = [
  "Some human documentation.",
  "",
  "```yaml",
  "extends: entity",
  "properties:",
  "  - key: role",
  "    type: string",
  "relations:",
  "  - key: works_on",
  "    targets: [project]",
  "    description: projects this person contributes to",
  "```",
  "",
  "More prose (ignored).",
].join("\n");

describe("extractYamlBlock", () => {
  it("extracts the first fenced yaml block", () => {
    expect(extractYamlBlock(BODY)).toContain("extends: entity");
  });
  it("returns null when there is no yaml block", () => {
    expect(extractYamlBlock("# just prose\n```js\nx\n```")).toBeNull();
  });
  it("round-trips CRLF bodies (fences with \\r\\n)", () => {
    const crlf = BODY.replace(/\n/g, "\r\n");
    expect(extractYamlBlock(crlf)).toContain("extends: entity");
  });
  it("returns the first block when multiple yaml blocks exist", () => {
    const body = "```yaml\nextends: entity\n```\n\nprose\n\n```yaml\nextends: other\n```";
    const block = extractYamlBlock(body);
    expect(block).toContain("extends: entity");
    expect(block).not.toContain("extends: other");
  });
});

describe("parseSchemaNote", () => {
  it("parses a valid schema note into a TypeDef", () => {
    const r = parseSchemaNote("Ontology/person.md", FM, BODY, parseYaml);
    expect(r.errors).toEqual([]);
    expect(r.def).toEqual({
      name: "person",
      version: 1,
      extendsType: "entity",
      properties: [{ key: "role", type: "string", required: false }],
      relations: [{ key: "works_on", targets: ["project"], description: "projects this person contributes to" }],
    });
  });
  it("parses a CRLF schema note identically", () => {
    const r = parseSchemaNote("Ontology/person.md", FM, BODY.replace(/\n/g, "\r\n"), parseYaml);
    expect(r.errors).toEqual([]);
    expect(r.def?.extendsType).toBe("entity");
    expect(r.def?.properties).toEqual([{ key: "role", type: "string", required: false }]);
    expect(r.def?.relations).toEqual([
      { key: "works_on", targets: ["project"], description: "projects this person contributes to" },
    ]);
  });
  it("rejects notes without the ontology marker", () => {
    const r = parseSchemaNote("Ontology/x.md", { type_name: "x" }, BODY, parseYaml);
    expect(r.def).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/ontology: type/);
  });
  it("rejects a missing type_name", () => {
    const r = parseSchemaNote("Ontology/x.md", { ontology: "type" }, BODY, parseYaml);
    expect(r.def).toBeUndefined();
    expect(r.errors[0]?.message).toMatch(/type_name/);
  });
  it("defaults version to 1 and tolerates a missing yaml block (bare type)", () => {
    const r = parseSchemaNote("Ontology/entity.md", { ontology: "type", type_name: "entity" }, "Just prose.", parseYaml);
    expect(r.errors).toEqual([]);
    expect(r.def).toEqual({ name: "entity", version: 1, properties: [], relations: [] });
  });
  it("treats an empty yaml block as a bare type", () => {
    const r = parseSchemaNote("Ontology/entity.md", { ontology: "type", type_name: "entity" }, "```yaml\n```", parseYaml);
    expect(r.errors).toEqual([]);
    expect(r.def).toEqual({ name: "entity", version: 1, properties: [], relations: [] });
  });
  it("rejects a non-mapping yaml block", () => {
    const r = parseSchemaNote("Ontology/x.md", FM, "```yaml\n- a\n- b\n```", parseYaml);
    expect(r.def).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/mapping/);
  });
  it("defaults a property without type to string", () => {
    const r = parseSchemaNote("Ontology/x.md", FM, "```yaml\nproperties:\n  - key: x\n```", parseYaml);
    expect(r.errors).toEqual([]);
    expect(r.def?.properties).toEqual([{ key: "x", type: "string", required: false }]);
  });
  it("parses a boolean property type", () => {
    const r = parseSchemaNote("Ontology/x.md", FM, "```yaml\nproperties:\n  - key: source_enriched\n    type: boolean\n```", parseYaml);
    expect(r.errors).toEqual([]);
    expect(r.def?.properties).toEqual([{ key: "source_enriched", type: "boolean", required: false }]);
  });
  it("rejects an unknown property type but keeps the valid entries", () => {
    const body = "```yaml\nproperties:\n  - key: x\n    type: blob\n  - key: y\n    type: number\n```";
    const r = parseSchemaNote("Ontology/x.md", FM, body, parseYaml);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/blob/);
    expect(r.def?.properties).toEqual([{ key: "y", type: "number", required: false }]);
  });
  it("rejects a relation without targets", () => {
    const body = "```yaml\nrelations:\n  - key: knows\n```";
    const r = parseSchemaNote("Ontology/x.md", FM, body, parseYaml);
    expect(r.errors[0]?.message).toMatch(/targets/);
    expect(r.errors[0]?.message).toMatch(/knows/);
    expect(r.def?.relations).toEqual([]);
  });
  it("accumulates every bad entry with its position", () => {
    const body = ["```yaml", "properties:", "  - type: string", "  - key: ok", "relations:", "  - key: knows", "```"].join("\n");
    const r = parseSchemaNote("Ontology/x.md", FM, body, parseYaml);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]?.message).toMatch(/properties\[0\]/);
    expect(r.errors[1]?.message).toMatch(/knows/);
    expect(r.def?.properties).toEqual([{ key: "ok", type: "string", required: false }]);
  });
  it("populates SchemaError.path", () => {
    const r = parseSchemaNote("Ontology/x.md", FM, "```yaml\nrelations:\n  - key: knows\n```", parseYaml);
    expect(r.errors[0]?.path).toBe("Ontology/x.md");
  });
  it("reports YAML syntax errors as SchemaError, not exceptions", () => {
    const body = "```yaml\nproperties: [unclosed\n```";
    const r = parseSchemaNote("Ontology/x.md", FM, body, parseYaml);
    expect(r.def).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/YAML/);
  });
});

function def(name: string, extendsType?: string, over: Partial<TypeDef> = {}): TypeDef {
  return { name, version: 1, ...(extendsType !== undefined ? { extendsType } : {}), properties: [], relations: [], ...over };
}

describe("resolveTypes", () => {
  it("merges inherited properties and relations, self first in lineage", () => {
    const entity = def("entity", undefined, { relations: [{ key: "related", targets: ["entity"] }] });
    const person = def("person", "entity", { properties: [{ key: "role", type: "string", required: false }] });
    const { resolved, errors } = resolveTypes([entity, person]);
    expect(errors).toEqual([]);
    const p = resolved.get("person")!;
    expect(p.lineage).toEqual(["person", "entity"]);
    expect(p.properties.map((x) => x.key)).toEqual(["role"]);
    expect(p.relations.map((x) => x.key)).toEqual(["related"]);
  });
  it("child overrides parent by key", () => {
    const entity = def("entity", undefined, { properties: [{ key: "status", type: "string", required: false }] });
    const proj = def("project", "entity", { properties: [{ key: "status", type: "string", required: true }] });
    const { resolved } = resolveTypes([entity, proj]);
    expect(resolved.get("project")!.properties).toEqual([{ key: "status", type: "string", required: true }]);
  });
  it("reports an unknown parent and excludes the child", () => {
    const { resolved, errors } = resolveTypes([def("x", "ghost")]);
    expect(resolved.has("x")).toBe(false);
    expect(errors[0].message).toMatch(/ghost/);
  });
  it("detects extends cycles and excludes their members", () => {
    const { resolved, errors } = resolveTypes([def("a", "b"), def("b", "a")]);
    expect(resolved.size).toBe(0);
    expect(errors.some((e) => /cycle/i.test(e.message))).toBe(true);
  });
  it("reports duplicate type names", () => {
    const { errors } = resolveTypes([def("a"), def("a")]);
    expect(errors.some((e) => /duplicate/i.test(e.message))).toBe(true);
  });
  it("records unknown relation targets as errors but keeps the type usable", () => {
    const t = def("a", undefined, { relations: [{ key: "r", targets: ["nowhere"] }] });
    const { resolved, errors } = resolveTypes([t]);
    expect(resolved.has("a")).toBe(true);
    expect(errors.some((e) => /nowhere/.test(e.message))).toBe(true);
  });
});
