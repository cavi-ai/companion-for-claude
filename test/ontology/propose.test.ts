import { describe, expect, it } from "vitest";
import { parseYaml } from "obsidian";
import { validateProposal } from "../../src/ontology/propose";
import { parseSchemaNote } from "../../src/ontology/schema";

const existing = new Set(["entity", "person", "project"]);

describe("validateProposal", () => {
  it("accepts a well-formed type and renders its schema note", () => {
    const out = validateProposal(existing, {
      name: "meeting",
      parent: "project",
      description: "A meeting",
      properties: [{ key: "date", type: "date", required: true }, { key: "attendees", type: "string[]" }],
      relations: [{ key: "about", targets: ["project", "meeting"] }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.fileName).toBe("meeting.md");
    expect(out.def).toMatchObject({ name: "meeting", version: 1, extendsType: "project" });
    expect(out.def.properties).toEqual([
      { key: "date", type: "date", required: true, description: undefined },
      { key: "attendees", type: "string[]", required: false, description: undefined },
    ]);
    expect(out.def.relations).toEqual([{ key: "about", targets: ["project", "meeting"], description: undefined }]);
    expect(out.content.startsWith("---\nontology: type\ntype_name: meeting\nversion: 1\n---")).toBe(true);
    expect(out.content).toContain("```yaml");
    expect(parseSchemaNote("meeting.md", { ontology: "type", type_name: "meeting", version: 1 }, out.content, parseYaml).def).toEqual(out.def);
  });

  it("defaults the parent to entity and allows no properties", () => {
    const out = validateProposal(existing, { name: "thing" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.def.extendsType).toBe("entity");
  });

  it("collects every violated rule", () => {
    const out = validateProposal(existing, {
      name: "Person",
      parent: "dragon",
      properties: [{ key: "type", type: "string" }, { key: "x", type: "money" }, { key: "x", type: "string" }],
      relations: [{ key: "Bad Key", targets: ["nowhere"] }],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/name .*Person/),
      expect.stringMatching(/parent 'dragon'/),
      expect.stringMatching(/key 'type' is reserved/),
      expect.stringMatching(/type 'money'/),
      expect.stringMatching(/duplicate.*'x'/),
      expect.stringMatching(/relation key 'Bad Key'/),
      expect.stringMatching(/target 'nowhere'/),
    ]));
  });

  it("rejects an existing name and a non-object", () => {
    expect(validateProposal(existing, { name: "person" })).toEqual({ ok: false, errors: ["A type named 'person' already exists."] });
    expect(validateProposal(existing, "person")).toEqual({ ok: false, errors: ["The proposal must be an object with a 'name'."] });
  });
});
