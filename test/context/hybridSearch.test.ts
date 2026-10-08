import { describe, it, expect, vi } from "vitest";
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

  it("ranks a short note on the topic above a long note full of common words", async () => {
    const app = new App();
    app.vault.seed("Notes/Pricing.md", "We decided the pricing tier is $20 a month.");
    const ramble = "What did we talk about? The team said what they think about the roadmap and what comes next. ".repeat(60);
    app.vault.seed("Notes/Weekly ramble.md", `${ramble}Pricing came up once.`);
    const hits = await keywordVaultSearch(app, "what did I decide about the pricing");
    expect(hits.map((h) => h.path)).toEqual(["Notes/Pricing.md", "Notes/Weekly ramble.md"]);
  });

  it("ranks the note with the rare term above one repeating a common term", async () => {
    const app = new App();
    for (let i = 0; i < 8; i++) app.vault.seed(`Notes/meeting ${i}.md`, "meeting meeting agenda");
    app.vault.seed("Notes/Infra.md", "Kubernetes cluster upgrade plan.");
    app.vault.seed("Notes/Busy.md", "meeting ".repeat(40));
    const hits = await keywordVaultSearch(app, "kubernetes meeting");
    expect(hits[0]?.path).toBe("Notes/Infra.md");
  });

  it("excludes the active note and ignores empty queries", async () => {
    const app = new App();
    app.vault.seed("a.md", "apple");
    app.vault.seed("b.md", "apple");
    expect((await keywordVaultSearch(app, "apple", "a.md")).map((h) => h.path)).toEqual(["b.md"]);
    expect(await keywordVaultSearch(app, "   ")).toEqual([]);
  });

  it("skips a file an accept predicate rejects before reading it", async () => {
    const app = new App();
    app.vault.seed("a.md", "apple");
    app.vault.seed("b.md", "apple");
    const readSpy = vi.spyOn(app.vault, "cachedRead");
    const hits = await keywordVaultSearch(app, "apple", null, (path) => path !== "a.md");
    expect(hits.map((h) => h.path)).toEqual(["b.md"]);
    expect(readSpy).not.toHaveBeenCalledWith(expect.objectContaining({ path: "a.md" }));
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
