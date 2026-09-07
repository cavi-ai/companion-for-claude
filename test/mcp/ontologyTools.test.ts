import { beforeEach, describe, expect, it } from "vitest";
import { App, parseYaml } from "obsidian";
import { VaultTools } from "../../src/mcp/vaultTools";
import { OntologyRegistry } from "../../src/ontology/registry";
import { SEED_TYPES, schemaNoteContent } from "../../src/ontology/seed";
import { isWriteTool } from "../../src/agent/tools";

let app: App;
let registry: OntologyRegistry;
let tools: VaultTools;
const FOLDER = "Ontology";

beforeEach(async () => {
  app = new App();
  registry = new OntologyRegistry({
    listSchemaNotes: async () => {
      const seeded = SEED_TYPES.map((def) => ({ path: `${FOLDER}/${def.name}.md`, frontmatter: { ontology: "type", type_name: def.name, version: def.version }, body: schemaNoteContent(def) }));
      const proposed = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${FOLDER}/`) && !SEED_TYPES.some((d) => f.path.endsWith(`/${d.name}.md`)));
      // vault.create never populates the fake's metadataCache — parse raw content instead (registry.test.ts's ioFromNotes pattern).
      const extra = await Promise.all(
        proposed.map(async (f) => {
          const raw = await app.vault.cachedRead(f);
          const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
          return m
            ? { path: f.path, frontmatter: parseYaml(m[1] ?? "") as Record<string, unknown>, body: m[2] ?? "" }
            : { path: f.path, body: raw };
        }),
      );
      return [...seeded, ...extra];
    },
    parseYaml,
  });
  await registry.load();
  app.vault.seed("People/Ada.md", "# Ada", { frontmatter: { type: "person" } });
  tools = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude", ontology: () => registry, ontologyFolder: () => FOLDER });
});

describe("ontology_get", () => {
  it("is a read tool, listed without writes", () => {
    tools.setOptions({ allowWrites: false, defaultFolder: "Claude", ontology: () => registry, ontologyFolder: () => FOLDER });
    expect(tools.definitions().some((d) => d.name === "ontology_get")).toBe(true);
    expect(tools.definitions().some((d) => d.name === "ontology_propose")).toBe(false);
    expect(isWriteTool("ontology_get")).toBe(false);
  });

  it("returns the registry as JSON, and one lineage on request", async () => {
    const all = JSON.parse(await tools.call("ontology_get", {})) as { types: Array<{ name: string }> };
    expect(all.types.map((t) => t.name).sort()).toEqual([...registry.resolved().keys()].sort());
    const one = JSON.parse(await tools.call("ontology_get", { type: "person" })) as { types: Array<{ name: string }> };
    expect(one.types[0]?.name).toBe("person");
    const missing = JSON.parse(await tools.call("ontology_get", { type: "dragon" })) as { note: string };
    expect(missing.note).toMatch(/Unknown type 'dragon'/);
  });
});

describe("ontology_propose", () => {
  it("is a write tool and writes a schema note the registry then resolves", async () => {
    expect(isWriteTool("ontology_propose")).toBe(true);
    // "meeting" is already a seeded type (src/ontology/seed.ts) — use a name that isn't.
    const out = await tools.call("ontology_propose", { name: "workshop", parent: "project", properties: [{ key: "date", type: "date", required: true }] });
    expect(out).toContain(`Created ${FOLDER}/workshop.md`);
    expect(app.vault.getAbstractFileByPath(`${FOLDER}/workshop.md`)).toBeTruthy();
    expect(registry.resolve("workshop")?.lineage).toEqual(["workshop", "project", "entity"]);
  });

  it("returns the rule violations and writes nothing", async () => {
    await expect(tools.call("ontology_propose", { name: "person" })).rejects.toThrow(/already exists/);
    await expect(tools.call("ontology_propose", { name: "x", parent: "dragon" })).rejects.toThrow(/parent 'dragon'/);
    expect(app.vault.getAbstractFileByPath(`${FOLDER}/x.md`)).toBeNull();
  });

  it("is gated by allowWrites", async () => {
    tools.setOptions({ allowWrites: false, defaultFolder: "Claude", ontology: () => registry, ontologyFolder: () => FOLDER });
    await expect(tools.call("ontology_propose", { name: "meeting" })).rejects.toThrow(/Write tools are disabled/);
  });
});

describe("conformance line on writes", () => {
  it("reports issues for a typed note after append, update, patch, and frontmatter writes", async () => {
    const append = await tools.call("note_append", { path: "People/Ada.md", content: "More." });
    expect(append).toMatch(/\nConformance: (ok|\d+ issue\(s\): .+)$/);
    const update = await tools.call("note_update", { path: "People/Ada.md", content: "# Ada\n\nNew body." });
    expect(update).toMatch(/\nConformance: /);
    const patch = await tools.call("note_patch", { path: "People/Ada.md", target: { kind: "document" }, op: "append", content: "Tail." });
    expect(patch).toMatch(/\nConformance: /);
    const fm = await tools.call("update_frontmatter", { path: "People/Ada.md", fields: { role: "engineer" } });
    expect(fm).toMatch(/\nConformance: /);
  });

  it("stays silent for untyped notes and when no ontology is loaded", async () => {
    app.vault.seed("Plain.md", "# Plain");
    expect(await tools.call("note_append", { path: "Plain.md", content: "x" })).not.toContain("Conformance:");
    tools.setOptions({ allowWrites: true, defaultFolder: "Claude" });
    expect(await tools.call("note_append", { path: "People/Ada.md", content: "x" })).not.toContain("Conformance:");
  });
});
