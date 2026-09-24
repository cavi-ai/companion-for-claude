import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { gatherContext } from "../../src/context/vaultContext";
import { DEFAULT_SETTINGS } from "../../src/types";

const NO_TOGGLES = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };
const SEARCH_ONLY = { ...NO_TOGGLES, searchVault: true };

function app(): App {
  const a = new App();
  a.workspace = { getActiveViewOfType: () => null, getActiveFile: () => null } as never;
  return a;
}

describe("gatherContext — searchScope", () => {
  it("excludes out-of-folder keyword hits", async () => {
    const a = app();
    a.vault.seed("folder/inside.md", "apple pie recipe");
    a.vault.seed("other/outside.md", "apple pie recipe");
    const scope = (path: string) => path.startsWith("folder/");
    const ctx = await gatherContext(a, DEFAULT_SETTINGS, SEARCH_ONLY, "apple", undefined, [], [], scope);
    expect(ctx.text).toContain("folder/inside.md");
    expect(ctx.text).not.toContain("other/outside.md");
  });

  it("excludes out-of-folder semantic hits even when the search fn ignores the scope", async () => {
    const a = app();
    const scope = (path: string) => path.startsWith("folder/");
    const semanticSearch = async () => [
      { path: "folder/inside.md", text: "in scope" },
      { path: "other/outside.md", text: "out of scope" },
    ];
    const ctx = await gatherContext(a, DEFAULT_SETTINGS, SEARCH_ONLY, "q", semanticSearch, [], [], scope);
    expect(ctx.text).toContain("folder/inside.md");
    expect(ctx.text).not.toContain("other/outside.md");
  });
});
