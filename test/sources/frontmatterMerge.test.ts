import { describe, it, expect } from "vitest";
import { App, TFile } from "obsidian";
import { applySourceFrontmatter } from "../../src/sources/frontmatterMerge";

describe("applySourceFrontmatter", () => {
  it("adds source keys, preserves the clipper's keys and the body", async () => {
    const app = new App();
    const file = app.vault.seed("Clippings/a.md", "---\nsource: https://x.com/p\n---\n\nBody text here.");
    await applySourceFrontmatter(app, file as TFile, { type: "article", summary: "S", source_enriched: true });
    const out = await app.vault.cachedRead(file as TFile);
    expect(out).toContain("type: article");
    expect(out).toContain("source_enriched: true");
    expect(out).toMatch(/source:.*x\.com\/p/);
    expect(out).toContain("Body text here.");
  });
});
