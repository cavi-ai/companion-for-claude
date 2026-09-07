import { beforeEach, describe, expect, it } from "vitest";
import { App, parseYaml } from "obsidian";
import { VaultTools } from "../../src/mcp/vaultTools";

// Block-list tags: the fake's processFrontMatter parses only block-list YAML and never updates metadataCache.
const NOTE = "---\ntitle: Plan\ntags:\n  - a\n---\n\n# Plan\n\n## Tasks\n\n- [ ] Create the parser ^t1\n\n## Notes\n\nLast words.\n";

let app: App;
let tools: VaultTools;

beforeEach(() => {
  app = new App();
  app.vault.seed("Plan.md", NOTE);
  tools = new VaultTools(app as never, { allowWrites: true, defaultFolder: "Claude" });
});

const read = () => app.vault.cachedRead(app.vault.getAbstractFileByPath("Plan.md") as never);
const frontmatter = async (): Promise<Record<string, unknown>> => {
  const raw = await read();
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  return m ? (parseYaml(m[1]) as Record<string, unknown>) : {};
};

describe("note_patch", () => {
  it("is listed only when writes are allowed", () => {
    expect(tools.definitions().some((d) => d.name === "note_patch")).toBe(true);
    tools.setOptions({ allowWrites: false, defaultFolder: "Claude" });
    expect(tools.definitions().some((d) => d.name === "note_patch")).toBe(false);
  });

  it("appends under a heading", async () => {
    const out = await tools.call("note_patch", { path: "Plan.md", target: { kind: "heading", heading: "Tasks" }, op: "append", content: "- [ ] Write the tests" });
    expect(out).toContain('section "Tasks"');
    expect(await read()).toContain("- [ ] Create the parser ^t1\n- [ ] Write the tests\n\n## Notes");
  });

  it("replaces a block by id, keeping the id", async () => {
    await tools.call("note_patch", { path: "Plan.md", target: { kind: "block", id: "^t1" }, op: "replace", content: "- [x] Create the tokenizer" });
    expect(await read()).toContain("- [x] Create the tokenizer ^t1");
  });

  it("appends to the document", async () => {
    await tools.call("note_patch", { path: "Plan.md", target: { kind: "document" }, op: "append", content: "Tail." });
    expect((await read()).endsWith("Last words.\n\nTail.\n")).toBe(true);
  });

  it("sets and extends frontmatter", async () => {
    await tools.call("note_patch", { path: "Plan.md", target: { kind: "frontmatter", key: "status" }, op: "replace", content: "active" });
    await tools.call("note_patch", { path: "Plan.md", target: { kind: "frontmatter", key: "tags" }, op: "append", content: "b" });
    await tools.call("note_patch", { path: "Plan.md", target: { kind: "frontmatter", key: "tags" }, op: "prepend", content: "z" });
    const fm = await frontmatter();
    expect(fm.status).toBe("active");
    expect(fm.tags).toEqual(["z", "a", "b"]);
  });

  it("rejects append on a scalar frontmatter key, unknown kinds, unknown ops, and missing targets", async () => {
    await expect(tools.call("note_patch", { path: "Plan.md", target: { kind: "frontmatter", key: "title" }, op: "append", content: "x" })).rejects.toThrow(/not a list/);
    await expect(tools.call("note_patch", { path: "Plan.md", target: { kind: "weird" }, op: "append", content: "x" })).rejects.toThrow(/Unknown target kind/);
    await expect(tools.call("note_patch", { path: "Plan.md", target: { kind: "document" }, op: "insert", content: "x" })).rejects.toThrow(/Unknown op/);
    await expect(tools.call("note_patch", { path: "Plan.md", target: { kind: "heading", heading: "Nope" }, op: "append", content: "x" })).rejects.toThrow("Section not found: Nope");
  });

  it("is gated by allowWrites", async () => {
    tools.setOptions({ allowWrites: false, defaultFolder: "Claude" });
    await expect(tools.call("note_patch", { path: "Plan.md", target: { kind: "document" }, op: "append", content: "x" })).rejects.toThrow(/Write tools are disabled/);
  });
});
