import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { fuseKeywordAndSemantic, keywordVaultSearch } from "../../src/context/hybridSearch";

describe("keywordVaultSearch", () => {
  it("scores content and path matches, best first, with snippets", async () => {
    const app = new App();
    app.vault.seed("Notes/apple pie.md", "A recipe for apple pie with cinnamon.");
    app.vault.seed("Notes/unrelated.md", "Nothing relevant here.");
    const hits = await keywordVaultSearch(app, "apple");
    expect(hits.map((h) => h.path)).toEqual(["Notes/apple pie.md"]);
    expect(hits[0]?.snippet).toContain("apple");
  });

  it("excludes the active note and ignores empty queries", async () => {
    const app = new App();
    app.vault.seed("a.md", "apple");
    app.vault.seed("b.md", "apple");
    expect((await keywordVaultSearch(app, "apple", "a.md")).map((h) => h.path)).toEqual(["b.md"]);
    expect(await keywordVaultSearch(app, "   ")).toEqual([]);
  });
});

describe("fuseKeywordAndSemantic", () => {
  it("dedupes by path, keeps the keyword snippet first, caps at limit", () => {
    const fused = fuseKeywordAndSemantic(
      [
        { path: "a.md", score: 5, snippet: "kw-a" },
        { path: "b.md", score: 1, snippet: "kw-b" },
      ],
      [
        { path: "b.md", text: "sem-b" },
        { path: "c.md", text: "sem-c" },
      ],
      10,
    );
    const paths = fused.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("c.md");
    expect(fused.find((f) => f.path === "b.md")?.snippet).toBe("kw-b"); // keyword snippet wins
  });

  it("drops hits without any snippet and honors the limit", () => {
    const fused = fuseKeywordAndSemantic(
      [{ path: "a.md", score: 5, snippet: "x" }],
      [{ path: "b.md", text: "" }],
      1,
    );
    expect(fused).toHaveLength(1);
  });
});
