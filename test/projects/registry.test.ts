import { parse } from "yaml";
import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { listChatProjects } from "../../src/projects/registry";
import { ResearchRepository, type ResearchRepositoryIO } from "../../src/research/repository";

class MemoryIO implements ResearchRepositoryIO {
  files = new Map<string, string>();
  folders = new Set<string>();
  async listMarkdown() {
    return [...this.files].map(([path, content]) => {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return { path, frontmatter: match ? parse(match[1] ?? "") : undefined, body: match?.[2] ?? content };
    });
  }
  async createWithParents(path: string, content: string) {
    this.files.set(path, content);
  }
  async updateFrontmatter() {
    throw new Error("not needed for this test");
  }
}

function app(): App {
  return new App();
}

describe("listChatProjects", () => {
  it("lists note projects alone when there is no research repository", async () => {
    const a = app();
    a.vault.seed("Claude/Projects/Solo.md", "Help with this.", { frontmatter: { type: "chat-project" } });
    const projects = await listChatProjects(a, null);
    expect(projects).toEqual([{ id: "Claude/Projects/Solo.md", name: "Solo", folder: null, pinned: [], instructions: "Help with this.", source: "note" }]);
  });

  it("merges chat-project notes with research projects", async () => {
    const a = app();
    a.vault.seed("Claude/Projects/Solo.md", "Help with this.", { frontmatter: { type: "chat-project" } });
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    await repo.createProject({ title: "AI Reviews", question: "How reliable are automated reviews?", folder: "Research/AI Reviews" });
    const projects = await listChatProjects(a, repo);
    expect(projects.map((p) => p.name)).toEqual(["Solo", "AI Reviews"]);
    expect(projects[1]).toMatchObject({ source: "research", folder: "Research/AI Reviews" });
  });

  it("drops a research project whose folder collides with a chat-project note — the note wins", async () => {
    const a = app();
    a.vault.seed("Claude/Notes/Project.md", "Custom instructions.", { frontmatter: { type: "chat-project", folder: "Research/AI Reviews" } });
    const io = new MemoryIO();
    const repo = new ResearchRepository(io);
    await repo.createProject({ title: "AI Reviews", question: "How reliable are automated reviews?", folder: "Research/AI Reviews" });
    const projects = await listChatProjects(a, repo);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ source: "note", folder: "Research/AI Reviews" });
  });
});
