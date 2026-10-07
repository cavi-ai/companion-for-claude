import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { gatherContext } from "../../src/context/vaultContext";
import { DEFAULT_SETTINGS } from "../../src/types";
import { hits, linkingApp, seededRegistry } from "./typedVault";

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

  it("never follows a typed relation out of the scope", async () => {
    const a = linkingApp();
    a.vault.seed("People/Ann.md", "ANN", { frontmatter: { type: "person", works_on: "[[Alpha]]", knows: ["[[Bob]]"] } });
    a.vault.seed("Projects/Alpha.md", "ALPHA BODY", { frontmatter: { type: "project" } });
    a.vault.seed("People/Bob.md", "BOB BODY", { frontmatter: { type: "person" } });
    const scope = (path: string) => path.startsWith("People/");
    const ctx = await gatherContext(a, DEFAULT_SETTINGS, SEARCH_ONLY, "q", hits("People/Ann.md"), [], [], scope, await seededRegistry());
    expect(ctx.text).toContain("### Related (knows of People/Ann.md): People/Bob.md (type: person)\nBOB BODY");
    expect(ctx.text).not.toContain("Projects/Alpha.md");
    expect(ctx.text).not.toContain("ALPHA BODY");
    expect(ctx.sources).toEqual(["1 semantic match", "1 related note"]);
  });
});
