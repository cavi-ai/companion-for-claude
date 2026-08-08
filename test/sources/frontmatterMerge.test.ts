import { describe, it, expect } from "vitest";
import { App, TFile } from "obsidian";
import { applySourceFrontmatter } from "../../src/sources/frontmatterMerge";
import { parse as parseYaml } from "yaml";

describe("applySourceFrontmatter", () => {
  it("adds source keys, preserves the clipper's keys and the body", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/a.md", "---\nsource: https://x.com/p\n---\n\nBody text here.");
    await applySourceFrontmatter(app, file as TFile, { type: "article", summary: "S", source_enriched: true });
    const out = await app.vault.cachedRead(file as TFile);
    expect(parseYaml(/^---\n([\s\S]*?)\n---/.exec(out)?.[1] ?? "").type).toBe("article");
    expect(out).toContain("source_enriched: true");
    expect(out).toMatch(/source:.*x\.com\/p/);
    expect(out).toContain("Body text here.");
  });

  it("unions tags instead of clobbering the clipper's own tags", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/b.md", "---\ntags:\n  - web-clip\n  - ai\n---\n\nBody.");
    await applySourceFrontmatter(app, file as TFile, { type: "article", tags: ["source"] });
    const out = await app.vault.cachedRead(file as TFile);
    expect(out).toContain("web-clip");
    expect(out).toContain("ai");
    expect(out).toContain("source");
  });

  it("handles string-shaped existing tags", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/c.md", "---\ntags: web-clip\n---\n\nBody.");
    await applySourceFrontmatter(app, file as TFile, { type: "article", tags: ["source"] });
    const out = await app.vault.cachedRead(file as TFile);
    expect(out).toContain("web-clip");
    expect(out).toContain("source");
  });

  it("normalizes existing and added tag variants to one canonical identity", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/variants.md", [
      "---",
      "tags:",
      "  - '#Source'",
      "  - Research Notes",
      "  - keep",
      "---",
      "",
      "Body.",
    ].join("\n"));

    await applySourceFrontmatter(app, file as TFile, {
      tags: ["source", "research-notes", "New Topic", "#new-topic"],
    });

    const out = await app.vault.cachedRead(file as TFile);
    const frontmatter = parseYaml(/^---\n([\s\S]*?)\n---/.exec(out)?.[1] ?? "");
    expect(frontmatter.tags).toEqual(["source", "research-notes", "keep", "new-topic"]);
  });
});
