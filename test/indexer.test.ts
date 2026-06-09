import { describe, it, expect } from "vitest";
import { SemanticIndexer, type IndexFile, type IndexerDeps } from "../src/semantic/indexer";
import type { IndexData } from "../src/semantic/store";

/** A fake vault + embedder. Embedding = deterministic bag-of-words over a tiny
 *  vocab, so "cats" and "feline cat" land near each other and far from "fish". */
function makeDeps(files: Record<string, string>) {
  const vocab = ["cat", "feline", "dog", "fish", "ocean", "code"];
  const embedCalls: string[][] = [];
  const store: { data: IndexData | null } = { data: null };

  const embed = async (input: string[]): Promise<number[][]> => {
    embedCalls.push(input);
    return input.map((t) => {
      const lower = t.toLowerCase();
      return vocab.map((w) => (lower.includes(w) ? 1 : 0));
    });
  };

  const deps: IndexerDeps = {
    embeddingModel: "fake-embed",
    listMarkdown: (): IndexFile[] => Object.keys(files).map((path) => ({ path, mtime: 1 })),
    read: async (path: string) => files[path] ?? "",
    embed,
    load: async () => store.data,
    save: async (d: IndexData) => {
      store.data = JSON.parse(JSON.stringify(d));
    },
  };
  return { deps, embedCalls, store, files };
}

describe("SemanticIndexer", () => {
  it("builds, persists, and finds the semantically closest note", async () => {
    const ctx = makeDeps({
      "cats.md": "# Cats\nThe feline cat is a small mammal.",
      "fish.md": "# Fish\nFish live in the ocean.",
      "code.md": "# Code\nWe write code in TypeScript.",
    });
    const ix = new SemanticIndexer(ctx.deps);
    const res = await ix.build();
    expect(res.indexed).toBe(3);
    expect(ctx.store.data).not.toBeNull();

    const hits = await ix.search("a feline pet", 2);
    expect(hits[0].path).toBe("cats.md");
  });

  it("skips unchanged notes on rebuild, re-embeds changed ones", async () => {
    const ctx = makeDeps({ "a.md": "cat content", "b.md": "fish content" });
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    const callsAfterFirst = ctx.embedCalls.length;

    // Second build, nothing changed → no new embed calls, both skipped.
    const res2 = await ix.build();
    expect(res2.indexed).toBe(0);
    expect(res2.skipped).toBe(2);
    expect(ctx.embedCalls.length).toBe(callsAfterFirst);

    // Change a note → only it re-embeds.
    ctx.files["a.md"] = "dog content now";
    const res3 = await ix.build();
    expect(res3.indexed).toBe(1);
    expect(res3.skipped).toBe(1);
  });

  it("force re-embeds everything", async () => {
    const ctx = makeDeps({ "a.md": "cat", "b.md": "fish" });
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    const res = await ix.build({ force: true });
    expect(res.indexed).toBe(2);
    expect(res.skipped).toBe(0);
  });

  it("prunes notes that left the vault", async () => {
    const ctx = makeDeps({ "a.md": "cat", "b.md": "fish" });
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    delete ctx.files["b.md"];
    const res = await ix.build();
    expect(res.removed).toBe(1);
    expect((await ix.stats()).notes).toBe(1);
  });

  it("updateNote / removeNote / renameNote mutate + persist", async () => {
    const ctx = makeDeps({ "a.md": "cat" });
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();

    ctx.files["a.md"] = "dog";
    await ix.updateNote("a.md", 2);
    expect((await ix.stats()).notes).toBe(1);

    await ix.renameNote("a.md", "a2.md");
    expect((await ix.search("dog", 1))[0].path).toBe("a2.md");

    await ix.removeNote("a2.md");
    expect((await ix.stats()).notes).toBe(0);
  });

  it("related: finds neighbors of an indexed note, excluding itself", async () => {
    const ctx = makeDeps({
      "cats.md": "The feline cat is a small mammal.",
      "kittens.md": "A kitten is a young cat, also feline.",
      "ocean.md": "Fish swim in the ocean.",
    });
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    const rel = await ix.related("cats.md", 5);
    expect(rel.map((r) => r.path)).not.toContain("cats.md");
    expect(rel[0].path).toBe("kittens.md"); // closest by shared cat/feline terms
  });

  it("search returns [] when the index is empty", async () => {
    const ctx = makeDeps({});
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    expect(await ix.search("anything", 5)).toEqual([]);
  });

  it("a note with no chunks (frontmatter only) is not indexed", async () => {
    const ctx = makeDeps({ "empty.md": "---\ntitle: X\n---\n", "a.md": "cat" });
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    expect((await ix.stats()).notes).toBe(1);
  });
});
