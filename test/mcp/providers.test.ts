import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { catalogPromptProvider, composeResourceProviders, resourcePath, resourceUri, substrateResourceProvider, vaultResourceProvider } from "../../src/mcp/providers";
import { WORKFLOWS } from "../../src/workflows/catalog";

describe("resource uris", () => {
  it("round-trips paths with spaces and slashes", () => {
    expect(resourceUri("Research/Alpha/My note.md")).toBe("obsidian://vault/Research/Alpha/My%20note.md");
    expect(resourcePath("obsidian://vault/Research/Alpha/My%20note.md")).toBe("Research/Alpha/My note.md");
    expect(resourcePath("https://example.com/x")).toBeNull();
  });
});

describe("vaultResourceProvider", () => {
  it("lists markdown notes with titles, pages by 200, and reads text", async () => {
    const app = new App();
    for (let i = 0; i < 205; i += 1) app.vault.seed(`N/${String(i).padStart(3, "0")}.md`, `# Note ${i}`);
    app.vault.seed("Titled.md", "body", { frontmatter: { title: "A real title" } });
    const provider = vaultResourceProvider(app as never);
    const first = await provider.list();
    expect(first.resources).toHaveLength(200);
    expect(first.nextCursor).toBeTruthy();
    const second = await provider.list(first.nextCursor);
    expect(second.resources).toHaveLength(6);
    expect(second.nextCursor).toBeUndefined();
    const titled = [...first.resources, ...second.resources].find((r) => r.uri === "obsidian://vault/Titled.md");
    expect(titled).toMatchObject({ name: "Titled", title: "A real title", mimeType: "text/markdown" });
    expect(provider.templates()).toEqual([{ uriTemplate: "obsidian://vault/{path}", name: "note", description: "A Markdown note by vault path", mimeType: "text/markdown" }]);
    expect(await provider.read("obsidian://vault/N/003.md")).toEqual({ uri: "obsidian://vault/N/003.md", mimeType: "text/markdown", text: "# Note 3" });
    expect(await provider.read("obsidian://vault/missing.md")).toBeNull();
    expect(await provider.read("obsidian://vault/../etc/passwd")).toBeNull();
  });
});

describe("catalogPromptProvider", () => {
  it("lists workflows and templates and renders them", async () => {
    const provider = catalogPromptProvider(async () => [{ name: "standup", description: "Standup", prompt: "Summarize {selection} in {active_note}", path: "T/standup.md" }]);
    const listed = await provider.list();
    expect(listed.map((p) => p.name)).toEqual([...WORKFLOWS.map((w) => w.id), "template:standup"]);
    const rollup = await provider.get("daily-rollup", { focus: "meetings" });
    expect(rollup?.messages[0]?.content.text.endsWith("\n\nFocus: meetings")).toBe(true);
    const template = await provider.get("template:standup", { selection: "S", active_note: "N" });
    expect(template?.messages[0]?.content.text).toBe("Summarize S in N");
    expect(await provider.get("nope", {})).toBeNull();
  });
});

describe("substrateResourceProvider", () => {
  const memoryPath = () => "Claude/Sessions/What Claude Knows.md";

  it("lists ontology only when a type exists and memory only when the note exists", async () => {
    const app = new App();
    const empty = substrateResourceProvider(app as never, { call: async () => JSON.stringify({ types: [], note: "No ontology is seeded." }), memoryPath });
    expect((await empty.list()).resources).toEqual([]);
    expect(await empty.read("obsidian://ontology")).toBeNull();
    expect(await empty.read("obsidian://memory")).toBeNull();

    app.vault.seed(memoryPath(), "# What Claude Knows\n- terse");
    const full = substrateResourceProvider(app as never, { call: async () => JSON.stringify({ types: [{ name: "person" }] }), memoryPath });
    expect((await full.list()).resources.map((r) => r.uri)).toEqual(["obsidian://ontology", "obsidian://memory"]);
    expect(await full.read("obsidian://memory")).toEqual({ uri: "obsidian://memory", mimeType: "text/markdown", text: "# What Claude Knows\n- terse" });
    expect((await full.read("obsidian://ontology"))?.mimeType).toBe("application/json");
  });

  it("treats a throwing ontology_get as no ontology", async () => {
    const p = substrateResourceProvider(new App() as never, { call: async () => { throw new Error("off"); }, memoryPath });
    expect((await p.list()).resources).toEqual([]);
  });

  it("reads a research snapshot by encoded project path; unknown or malformed → null", async () => {
    const call = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (args.project === "Research/My Alpha/Project.md") return '{"project":{}}';
      throw new Error("Project not found");
    });
    const p = substrateResourceProvider(new App() as never, { call, memoryPath });
    expect(await p.read("obsidian://research/Research/My%20Alpha/Project.md")).toEqual({ uri: "obsidian://research/Research/My%20Alpha/Project.md", mimeType: "application/json", text: '{"project":{}}' });
    expect(call).toHaveBeenCalledWith("research_project_read", { project: "Research/My Alpha/Project.md" });
    expect(await p.read("obsidian://research/Nope.md")).toBeNull();
    expect(await p.read("obsidian://research/%E0%A4%A.md")).toBeNull();
    expect(p.templates()).toEqual([{ uriTemplate: "obsidian://research/{project}", name: "research-project", description: "Research project snapshot by project note path", mimeType: "application/json" }]);
  });
});

describe("composeResourceProviders", () => {
  it("prepends fixed resources on the first page only and keeps vault paging", async () => {
    const app = new App();
    for (let i = 0; i < 205; i += 1) app.vault.seed(`N/${String(i).padStart(3, "0")}.md`, `# Note ${i}`);
    app.vault.seed("Claude/Sessions/What Claude Knows.md", "m");
    const composed = composeResourceProviders(
      substrateResourceProvider(app as never, { call: async () => "{}", memoryPath: () => "Claude/Sessions/What Claude Knows.md" }),
      vaultResourceProvider(app as never),
    );
    const first = await composed.list();
    expect(first.resources[0]?.uri).toBe("obsidian://memory");
    expect(first.resources).toHaveLength(201);
    const second = await composed.list(first.nextCursor);
    expect(second.resources.some((r) => r.uri === "obsidian://memory")).toBe(false);
    expect(composed.templates().map((t) => t.uriTemplate)).toEqual(["obsidian://research/{project}", "obsidian://vault/{path}"]);
    expect((await composed.read("obsidian://vault/N/001.md"))?.text).toBe("# Note 1");
    expect((await composed.read("obsidian://memory"))?.text).toBe("m");
  });
});
