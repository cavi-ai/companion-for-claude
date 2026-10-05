import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { vaultTagEntries, vaultVocabulary } from "../../src/tags/vaultTags";

describe("vaultTags", () => {
  const app = new App();
  app.vault.seed("A.md", "a", { tags: ["llm", "rust"] });
  app.vault.seed("B.md", "b", { frontmatter: { tags: ["llm"] } });
  app.vault.seed("C.md", "c");

  it("reads raw tags per note with the leading # stripped", () => {
    expect(vaultTagEntries(app as never)).toEqual([
      { path: "A.md", tags: ["llm", "rust"] },
      { path: "B.md", tags: ["llm"] },
    ]);
  });

  it("builds a vocabulary counting distinct notes", () => {
    const vocab = vaultVocabulary(app as never);
    expect(vocab.get("llm")?.count).toBe(2);
    expect(vocab.get("rust")?.notes).toEqual(["A.md"]);
  });
});
