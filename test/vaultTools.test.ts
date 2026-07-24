import { describe, it, expect, vi } from "vitest";
import { App } from "obsidian";
import { parse as parseYaml } from "yaml";
import { VaultTools, assertVaultPath } from "../src/mcp/vaultTools";
import { OntologyRegistry } from "../src/ontology/registry";
import { schemaNoteContent, SEED_TYPES } from "../src/ontology/seed";

function tools(allowWrites = true) {
  const app = new App();
  app.vault.seed("Notes/Alpha.md", "# Alpha\nLinks to [[Beta]].\n");
  app.vault.seed("Notes/Beta.md", "# Beta\nStandalone.\n");
  app.vault.seed("Inbox/Gamma.md", "# Gamma\n");
  const vt = new VaultTools(app as never, { allowWrites, defaultFolder: "Claude" });
  return { app, vt };
}

describe("assertVaultPath — vault-escape guard", () => {
  it("accepts normal vault-relative paths", () => {
    expect(assertVaultPath("Notes/Alpha.md")).toBe("Notes/Alpha.md");
    expect(assertVaultPath("")).toBe("");
    // normalizePath strips a leading slash, so an "absolute" path stays in-vault.
    expect(assertVaultPath("/etc/passwd")).toBe("etc/passwd");
  });
  it("rejects `..` traversal", () => {
    expect(() => assertVaultPath("../../../etc/passwd")).toThrow(/escapes the vault/);
    expect(() => assertVaultPath("Notes/../../secret.md")).toThrow(/escapes the vault/);
  });
});

describe("research tools", () => {
  it("always defines reads/audit but only advertises mutations when writes are enabled", () => {
    const readNames = tools(false).vt.definitions().map(({ name }) => name);
    expect(new Set(readNames).size).toBe(readNames.length);
    expect(readNames.filter((name) => name.startsWith("research_"))).toEqual(["research_project_read", "research_audit"]);
    const writeNames = tools(true).vt.definitions().map(({ name }) => name);
    expect(new Set(writeNames).size).toBe(writeNames.length);
    expect(writeNames.filter((name) => name.startsWith("research_"))).toEqual([
      "research_project_read",
      "research_audit",
      "research_project_create",
      "research_source_import",
      "research_evidence_capture",
      "research_evidence_review",
      "research_claim_create",
      "research_claim_link",
      "research_outline_generate",
    ]);
    for (const name of ["research_evidence_create", "research_outline_create"]) {
      expect(readNames).not.toContain(name);
      expect(writeNames).not.toContain(name);
    }
  });

  it("creates a project and imports a metadata-only source through the public route", async () => {
    const { app, vt } = tools(true);
    const created = JSON.parse(await vt.call("research_project_create", { title: "Alpha", question: "Why?", folder: "Research/Alpha" }));
    expect(created.path).toBe("Research/Alpha/Project.md");
    const imported = JSON.parse(await vt.call("research_source_import", { project: created.path, title: "Paper", source_kind: "doi", doi: "10.1234/example" }));
    expect(imported.kind).toBe("created");
    expect(app.vault.getAbstractFileByPath(imported.path)).not.toBeNull();
  });

  it("blocks proposed claims at the public outline route without creating a document", async () => {
    const { app, vt } = tools(true);
    const project = JSON.parse(await vt.call("research_project_create", { title: "Trust", question: "What is supported?", folder: "Research/Trust" })).path;
    const source = JSON.parse(await vt.call("research_source_import", { project, title: "Paper", source_kind: "web", url: "https://example.test", captured_text: "Result" })).path;
    const evidence = JSON.parse(await vt.call("research_evidence_capture", { project, source, title: "Result", excerpt: "Result", locator_kind: "section", locator_value: "Results", review_state: "reviewed" })).path;
    const claim = JSON.parse(await vt.call("research_claim_create", { project, title: "Proposed", proposition: "This must not leak", supports: [evidence], review_state: "proposed" })).path;
    await expect(vt.call("research_outline_generate", { project, claims: [claim] })).rejects.toThrow(/proposed claim.*review.*remove/i);
    expect(app.vault.getAbstractFileByPath("Research/Trust/Documents/Outline.md")).toBeNull();
  });

  it("rejects research mutations when MCP writes are disabled", async () => {
    await expect(tools(false).vt.call("research_claim_create", { project: "P/Project.md", title: "C", proposition: "x" })).rejects.toThrow(/disabled/);
    for (const name of ["research_evidence_create", "research_outline_create"]) {
      await expect(tools(false).vt.call(name, {})).rejects.toThrow(/disabled/);
    }
  });

  it("reads only the canonical project tree and surfaces damaged research metadata", async () => {
    const app = new App();
    const project = "Research/P/Project.md";
    app.vault.seed(project, "# project", { frontmatter: { title: "P", type: "research-project", project: `[[${project}]]`, question: "Why?", stage: "frame", status: "active" } });
    app.vault.seed("Research/P/Sources/S.md", "# source", { frontmatter: { title: "S", type: "research-source", project: `[[${project}]]`, source_kind: "web" } });
    app.vault.seed("Research/P/Evidence/Damaged type.md", "# damaged", { frontmatter: { title: "Damaged", type: "not-research", project: `[[${project}]]` } });
    app.vault.seed("Research/P/Claims/Damaged project.md", "# damaged", { frontmatter: { title: "Damaged", type: "claim", project: 42, proposition: "X", confidence: "low", review_state: "proposed" } });
    app.vault.seed("Research/P/Loose.md", "not in canonical layout", { frontmatter: { type: "not-research" } });
    for (let index = 0; index < 100; index += 1) app.vault.seed(`Notes/N${index}.md`, "unrelated body", { frontmatter: { type: "note" } });
    const read = vi.spyOn(app.vault, "cachedRead");
    const output = await new VaultTools(app as never, { allowWrites: false, defaultFolder: "Claude" }).call("research_project_read", { project });
    const summary = JSON.parse(output);
    expect(summary.counts.sources).toBe(1);
    expect(summary.counts.issues).toBe(2);
    expect(summary.paths.issues.items).toEqual(expect.arrayContaining(["Research/P/Evidence/Damaged type.md", "Research/P/Claims/Damaged project.md"]));
    expect(read).toHaveBeenCalledTimes(4);
    read.mockClear();
    const findings = JSON.parse(await new VaultTools(app as never, { allowWrites: false, defaultFolder: "Claude" }).call("research_audit", { project }));
    expect(findings.filter(({ rule }: { rule: string }) => rule === "invalid-record")).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(4);
  });
});

describe("write tools reject vault escapes", () => {
  it("note_create with a traversal folder is refused", async () => {
    const { vt } = tools();
    await expect(vt.call("note_create", { title: "Evil", content: "x", folder: "../../.." })).rejects.toThrow(/escapes the vault/);
  });
  it("note_move to a path outside the vault is refused", async () => {
    const { vt } = tools();
    await expect(vt.call("note_move", { path: "Notes/Alpha.md", to: "../../../tmp/evil.md" })).rejects.toThrow(/escapes the vault/);
  });
});

describe("list_titles", () => {
  it("lists every markdown note's path and title", async () => {
    const { vt } = tools();
    const out = await vt.call("list_titles", {});
    expect(out).toContain("Notes/Alpha.md");
    expect(out).toContain("Notes/Beta.md");
    expect(out).toContain("Inbox/Gamma.md");
    expect(out).toContain("Alpha");
  });
});

function linkedTools() {
  const app = new App();
  app.vault.seed("Notes/Alpha.md", "# Alpha\n[[Beta]]\n");
  app.vault.seed("Notes/Beta.md", "# Beta\n");
  app.vault.seed("Notes/Gamma.md", "# Gamma\n[[Beta]]\n");
  // resolvedLinks: source -> { target: count }
  app.metadataCache.resolvedLinks = {
    "Notes/Alpha.md": { "Notes/Beta.md": 1 },
    "Notes/Beta.md": {},
    "Notes/Gamma.md": { "Notes/Beta.md": 1 },
  };
  return new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude" });
}

describe("get_backlinks", () => {
  it("lists notes that link to the target", async () => {
    const out = await linkedTools().call("get_backlinks", { path: "Notes/Beta.md" });
    expect(out).toContain("Notes/Alpha.md");
    expect(out).toContain("Notes/Gamma.md");
    expect(out).not.toContain("Notes/Beta.md");
  });

  it("reports when there are no backlinks", async () => {
    const out = await linkedTools().call("get_backlinks", { path: "Notes/Alpha.md" });
    expect(out).toMatch(/No backlinks/);
  });
});

describe("get_outgoing_links", () => {
  it("lists the notes a note links to", async () => {
    const out = await linkedTools().call("get_outgoing_links", { path: "Notes/Alpha.md" });
    expect(out).toContain("Notes/Beta.md");
  });
});

describe("note_update", () => {
  it("replaces the whole note content", async () => {
    const { vt } = tools();
    await vt.call("note_update", { path: "Notes/Beta.md", content: "# Beta\nrewritten\n" });
    const read = await vt.call("note_read", { path: "Notes/Beta.md" });
    expect(read).toBe("# Beta\nrewritten\n");
  });

  it("replaces only a named section when 'section' is given", async () => {
    const { vt } = tools();
    await vt.call("note_update", { path: "Notes/Alpha.md", content: "# Alpha\n\n## Log\nstart\n" });
    await vt.call("note_update", { path: "Notes/Alpha.md", section: "Log", content: "updated" });
    const read = await vt.call("note_read", { path: "Notes/Alpha.md" });
    expect(read).toContain("## Log\n\nupdated\n");
  });

  it("is rejected when writes are disabled", async () => {
    const { vt } = tools(false);
    await expect(vt.call("note_update", { path: "Notes/Beta.md", content: "x" })).rejects.toThrow(/disabled/);
  });
});

describe("update_frontmatter", () => {
  it("unions tags (normalized) and preserves other keys and the body", async () => {
    const app = new App();
    app.vault.seed("Notes/Tagged.md", "---\ntitle: Tagged\ntags:\n  - a\n---\n\n# Tagged\nbody\n");
    const vt = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude" });
    await vt.call("update_frontmatter", { path: "Notes/Tagged.md", tags: ["B", "a"] });
    const read = await vt.call("note_read", { path: "Notes/Tagged.md" });
    expect(read).toContain('tags:\n  - "a"\n  - "b"\n');
    expect(read).toContain('title: "Tagged"');
    expect(read).toContain("# Tagged\nbody");
  });

  it("is rejected when writes are disabled", async () => {
    const app = new App();
    app.vault.seed("Notes/Tagged.md", "# Tagged\n");
    const vt = new VaultTools(app as never, { allowWrites: false, defaultFolder: "Claude" });
    await expect(vt.call("update_frontmatter", { path: "Notes/Tagged.md", tags: ["x"] })).rejects.toThrow(/disabled/);
  });
});

describe("frontmatter_query", () => {
  function fmTools() {
    const app = new App();
    app.vault.seed("P/A.md", "# A", { frontmatter: { type: "project", status: "active" } });
    app.vault.seed("P/B.md", "# B", { frontmatter: { type: "project", status: "done" } });
    app.vault.seed("N/C.md", "# C", { frontmatter: { type: "note", tags: ["x", "y"] } });
    return new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude" });
  }

  it("lists notes that have a frontmatter field", async () => {
    const out = await fmTools().call("frontmatter_query", { field: "status" });
    expect(out).toContain("P/A.md");
    expect(out).toContain("P/B.md");
    expect(out).not.toContain("N/C.md");
  });

  it("filters by scalar value", async () => {
    const out = await fmTools().call("frontmatter_query", { field: "type", value: "project" });
    expect(out).toContain("P/A.md");
    expect(out).toContain("P/B.md");
    expect(out).not.toContain("N/C.md");
  });

  it("matches membership when the field is an array", async () => {
    const out = await fmTools().call("frontmatter_query", { field: "tags", value: "x" });
    expect(out).toContain("N/C.md");
    expect(out).not.toContain("P/A.md");
  });

  it("reports when nothing matches", async () => {
    const out = await fmTools().call("frontmatter_query", { field: "missing" });
    expect(out).toMatch(/No notes/);
  });
});

describe("note_move", () => {
  function moveTools(allowWrites = true) {
    const app = new App();
    app.vault.seed("Inbox/Draft.md", "# Draft\n");
    return { app, vt: new VaultTools(app as never, { allowWrites, defaultFolder: "Claude" }) };
  }

  it("moves a note to a new path", async () => {
    const { vt } = moveTools();
    const msg = await vt.call("note_move", { path: "Inbox/Draft.md", to: "Notes/Final.md" });
    expect(msg).toContain("Notes/Final.md");
    expect(await vt.call("note_read", { path: "Notes/Final.md" })).toBe("# Draft\n");
    await expect(vt.call("note_read", { path: "Inbox/Draft.md" })).rejects.toThrow(/not found/);
  });

  it("is rejected when writes are disabled", async () => {
    const { vt } = moveTools(false);
    await expect(vt.call("note_move", { path: "Inbox/Draft.md", to: "Notes/Final.md" })).rejects.toThrow(/disabled/);
  });
});

async function seededRegistry(): Promise<OntologyRegistry> {
  const reg = new OntologyRegistry({
    listSchemaNotes: () =>
      Promise.resolve(
        SEED_TYPES.map((d) => {
          const content = schemaNoteContent(d);
          const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
          return { path: `Ontology/${d.name}.md`, frontmatter: parseYaml(m[1] ?? "") as Record<string, unknown>, body: m[2] ?? "" };
        }),
      ),
    parseYaml,
  });
  await reg.load();
  return reg;
}

describe("note_create with ontology", () => {
  async function ontologyTools() {
    const reg = await seededRegistry();
    const app = new App();
    const vt = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude", ontology: () => reg });
    return { app, vt };
  }

  it("writes type + validated properties into frontmatter", async () => {
    const { vt } = await ontologyTools();
    const msg = await vt.call("note_create", {
      title: "Franco",
      content: "body",
      type: "person",
      properties: { role: "engineer", works_on: "[[CAVI]]" },
    });
    expect(msg).toContain("Created note:");
    const read = await vt.call("note_read", { path: "Claude/Franco.md" });
    expect(read).toContain('type: "person"');
    expect(read).toContain('role: "engineer"');
    expect(read).toContain('- "[[CAVI]]"'); // scalar relation wrapped to a list
  });

  it("reports conformance issues in the result instead of failing", async () => {
    const { vt } = await ontologyTools();
    const msg = await vt.call("note_create", {
      title: "Franco",
      content: "body",
      type: "person",
      properties: { banana: 1 },
    });
    expect(msg).toContain("Conformance:");
    expect(msg).toContain("banana");
    const read = await vt.call("note_read", { path: "Claude/Franco.md" });
    expect(read).toContain('type: "person"');
  });

  it("reports an unknown type and creates the note untyped", async () => {
    const { vt } = await ontologyTools();
    const msg = await vt.call("note_create", { title: "Franco", content: "body", type: "ghost" });
    expect(msg).toContain("unknown type");
    expect(msg).toContain("available:");
    expect(msg).toContain("person");
    const read = await vt.call("note_read", { path: "Claude/Franco.md" });
    expect(read).not.toContain("type:");
  });

  it("protects base keys from model-supplied properties", async () => {
    const { vt } = await ontologyTools();
    await vt.call("note_create", {
      title: "Franco",
      content: "body",
      type: "person",
      properties: { tags: "foo", type: "other", role: "x" },
    });
    const read = await vt.call("note_read", { path: "Claude/Franco.md" });
    expect(read).toContain('type: "person"');
    expect(read).toContain('tags:\n  - "claude"');
    expect(read).not.toContain("foo");
    expect(read).not.toContain("other");
    expect(read).toContain('role: "x"');
  });

  it("hides type/properties from the schema when the registry is empty (enabled but not seeded)", async () => {
    const empty = new OntologyRegistry({ listSchemaNotes: () => Promise.resolve([]), parseYaml });
    await empty.load();
    const app = new App();
    const vt = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude", ontology: () => empty });
    const noteCreate = vt.definitions().find((d) => d.name === "note_create");
    expect(noteCreate).toBeDefined();
    const props = (noteCreate!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("type");
    expect(props).not.toHaveProperty("properties");
  });

  it("keeps legacy behavior when no ontology is wired", async () => {
    const app = new App();
    const vt = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude", ontology: () => null });
    const msg = await vt.call("note_create", {
      title: "Franco",
      content: "body",
      type: "person",
      properties: { role: "engineer" },
    });
    expect(msg).not.toContain("Conformance:");
    const read = await vt.call("note_read", { path: "Claude/Franco.md" });
    expect(read).not.toContain("type:");
    expect(read).not.toContain("role:");
    expect(read).toContain('title: "Franco"');
    expect(read).toContain('source: "claude-mcp"');
    expect(read).toContain('tags:\n  - "claude"');
  });
});
