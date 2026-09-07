import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { catalogPromptProvider, resourcePath, resourceUri, vaultResourceProvider } from "../../src/mcp/providers";
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
