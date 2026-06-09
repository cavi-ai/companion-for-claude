import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { VaultTools } from "../src/mcp/vaultTools";

function tools(allowWrites = true) {
  const app = new App();
  app.vault.seed("Notes/Alpha.md", "# Alpha\nLinks to [[Beta]].\n");
  app.vault.seed("Notes/Beta.md", "# Beta\nStandalone.\n");
  app.vault.seed("Inbox/Gamma.md", "# Gamma\n");
  const vt = new VaultTools(app as never, { allowWrites, defaultFolder: "Claude" });
  return { app, vt };
}

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
    expect(read).toContain("tags:\n  - a\n  - b\n");
    expect(read).toContain("title: Tagged");
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
