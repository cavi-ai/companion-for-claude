import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { gatherContext } from "../src/context/vaultContext";
import { rememberTurnContext, readTurnContext } from "../src/chat/turnSources";
import { DEFAULT_SETTINGS } from "../src/types";

const NO_TOGGLES = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

function app(): App {
  const a = new App();
  a.workspace = { getActiveViewOfType: () => null, getActiveFile: () => null } as never;
  return a;
}

describe("gatherContext — attached web pages", () => {
  it("preserves gathered page context through bounded accepted-turn persistence", async () => {
    const pages = [{ url: "https://example.test/long", title: "Long article", markdown: "abc ".repeat(10000) }];
    const original = await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], pages);
    const saved = rememberTurnContext([], pages);
    expect(saved.pages[0]!.markdown.length).toBe(6000);
    const restored = readTurnContext(JSON.parse(JSON.stringify([{ role: "user", content: "q", contextAttachments: saved }])));
    expect(await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], restored.pages)).toEqual(original);
  });

  it("includes captured pages as labeled blocks within the budget", async () => {
    const ctx = await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], [
      { url: "https://example.com/a", title: "Page A", markdown: "Content of A." },
      { url: "https://example.com/b", markdown: "Content of B." },
    ]);
    expect(ctx.text).toContain("Web page: Page A (https://example.com/a)");
    expect(ctx.text).toContain("Content of A.");
    expect(ctx.text).toContain("Web page: https://example.com/b (https://example.com/b)");
    expect(ctx.sources).toEqual(["2 pages"]);
  });

  it("skips pending and failed pages", async () => {
    const ctx = await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], [
      { url: "https://example.com/a", markdown: "", pending: true },
      { url: "https://example.com/b", markdown: "", error: "Fetch failed with status 404" },
      { url: "https://example.com/c", markdown: "Real content." },
    ]);
    expect(ctx.text).toContain("Real content.");
    expect(ctx.text).not.toContain("example.com/a");
    expect(ctx.text).not.toContain("example.com/b");
    expect(ctx.sources).toEqual(["1 page"]);
  });

  it("clips page content to the per-page cap", async () => {
    const ctx = await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], [
      { url: "https://example.com/big", markdown: "x".repeat(20000) },
    ]);
    expect(ctx.text.length).toBeLessThan(7000);
    expect(ctx.sources).toEqual(["1 page"]);
  });

  it("returns empty context when every page failed", async () => {
    const ctx = await gatherContext(app(), DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], [
      { url: "https://example.com/b", markdown: "", error: "boom" },
    ]);
    expect(ctx.text).toBe("");
    expect(ctx.sources).toEqual([]);
  });
});
