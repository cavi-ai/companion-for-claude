import { describe, expect, it, vi } from "vitest";
import { App, parseYaml } from "obsidian";
import { VaultTools, type VaultToolsOptions } from "../../src/mcp/vaultTools";
import { OntologyRegistry } from "../../src/ontology/registry";
import { SEED_TYPES, schemaNoteContent } from "../../src/ontology/seed";
import { createResearchRepository } from "../../src/research/repositoryFactory";

vi.mock("../../src/research/repositoryFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/research/repositoryFactory")>();
  return { ...actual, createResearchRepository: vi.fn(actual.createResearchRepository) };
});

function options(overrides: Partial<VaultToolsOptions> = {}): VaultToolsOptions {
  return {
    allowWrites: true,
    defaultFolder: "Claude",
    semantic: async () => [],
    ontology: () => null,
    ontologyFolder: () => "Ontology",
    zotero: () => undefined,
    webSearch: async () => "",
    webFetch: async () => "",
    related: async () => [],
    memoryRecord: { enabled: () => true, path: () => "Memory.md", today: () => "2026-01-01", newNote: (body) => body },
    ...overrides,
  };
}

describe("tool assembly", () => {
  it("lists the vault tools in discovery order around the research tools", () => {
    const names = new VaultTools(new App() as never, options()).definitions().map((d) => d.name);
    expect(names).toEqual([
      "vault_search",
      "related_notes",
      "note_read",
      "list_recent",
      "vault_tags",
      "list_titles",
      "get_backlinks",
      "get_outgoing_links",
      "frontmatter_query",
      "ontology_get",
      "research_project_read",
      "research_audit",
      "web_search",
      "web_fetch",
      "memory_record",
      "note_create",
      "note_append",
      "note_update",
      "note_patch",
      "update_frontmatter",
      "note_move",
      "base_create",
      "canvas_create",
      "ontology_propose",
      "research_project_create",
      "research_source_import",
      "research_evidence_capture",
      "research_evidence_review",
      "research_evidence_locate",
      "research_claim_review",
      "research_claim_create",
      "research_claim_link",
      "research_outline_generate",
    ]);
  });

  it("builds the records once per options", async () => {
    const app = new App();
    app.vault.seed("Notes/Alpha.md", "# Alpha\n");
    const create = vi.mocked(createResearchRepository);
    create.mockClear();
    const tools = new VaultTools(app as never, options());
    tools.definitions();
    for (let i = 0; i < 3; i++) await tools.call("note_read", { path: "Notes/Alpha.md" });
    expect(create).toHaveBeenCalledTimes(1);
    tools.setOptions(options());
    tools.definitions();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reflects new options after setOptions", () => {
    const tools = new VaultTools(new App() as never, options());
    expect(tools.definitions().some((d) => d.name === "note_create")).toBe(true);
    expect(tools.unavailable("note_create")).toBeUndefined();
    tools.setOptions(options({ allowWrites: false }));
    expect(tools.definitions().some((d) => d.name === "note_create")).toBe(false);
    expect(tools.unavailable("note_create")).toMatch(/Write tools are disabled/);
    expect(tools.definitions().map((d) => d.name)).toContain("web_search");
    tools.setOptions(options({ webSearch: undefined }));
    expect(tools.unavailable("web_search")).toMatch(/Web search is disabled/);
    expect(tools.definitions().map((d) => d.name)).not.toContain("web_search");
  });

  it("follows the ontology registry contents when listing note_create", async () => {
    const registry = new OntologyRegistry({
      listSchemaNotes: async () => SEED_TYPES.map((def) => ({ path: `Ontology/${def.name}.md`, frontmatter: { ontology: "type", type_name: def.name, version: def.version }, body: schemaNoteContent(def) })),
      parseYaml,
    });
    const tools = new VaultTools(new App() as never, options({ ontology: () => registry }));
    const schema = () => tools.definitions().find((d) => d.name === "note_create")!.inputSchema.properties as Record<string, unknown>;
    expect(schema()).not.toHaveProperty("type");
    await registry.load();
    expect(schema()).toHaveProperty("type");
    expect(schema()).toHaveProperty("properties");
  });

  it("reads memory_record availability at call time", () => {
    let enabled = true;
    const tools = new VaultTools(new App() as never, options({ memoryRecord: { enabled: () => enabled, path: () => "Memory.md", today: () => "2026-01-01", newNote: (body) => body } }));
    expect(tools.unavailable("memory_record")).toBeUndefined();
    enabled = false;
    expect(tools.unavailable("memory_record")).toMatch(/Memory recording is off/);
    expect(tools.definitions().some((d) => d.name === "memory_record")).toBe(false);
  });
});
