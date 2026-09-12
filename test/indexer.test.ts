import { describe, it, expect, vi } from "vitest";
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
  it("does not prune a note incrementally indexed while a full rebuild is in flight", async () => {
    const ctx = makeDeps({ "existing.md": "cat" });
    let releaseExisting!: () => void;
    const existingBlocked = new Promise<void>((resolve) => { releaseExisting = resolve; });
    let existingStarted!: () => void;
    const started = new Promise<void>((resolve) => { existingStarted = resolve; });
    ctx.deps.embed = async (input) => {
      if (input.some((text) => text.includes("cat"))) {
        existingStarted();
        await existingBlocked;
      }
      return input.map(() => [1, 0, 0, 0, 0, 0]);
    };
    const ix = new SemanticIndexer(ctx.deps);

    const rebuilding = ix.build({ force: true });
    await started;
    ctx.files["new.md"] = "dog";
    const updating = ix.updateNote("new.md", 2);
    await Promise.resolve();
    releaseExisting();
    await Promise.all([rebuilding, updating]);

    expect((await ix.stats()).notes).toBe(2);
  });

  it("isolates per-file embedding failures and reports them for recovery", async () => {
    const ctx = makeDeps({ "broken.md": "cat", "healthy.md": "fish" });
    ctx.deps.embed = async (input) => {
      if (input.some((text) => text.includes("cat"))) throw new Error("Ollama refused connection");
      return input.map(() => [0, 1, 0, 0, 0, 0]);
    };
    const result = await new SemanticIndexer(ctx.deps).build({ force: true });

    expect(result).toMatchObject({ indexed: 1, skipped: 1, failureCount: 1 });
    expect(result.failures).toEqual([{ path: "broken.md", message: "Ollama refused connection" }]);
  });

  it("rejects an oversized file before reading or embedding it", async () => {
    const ctx = makeDeps({ "large.md": "cat" });
    let reads = 0;
    ctx.deps.listMarkdown = () => [{ path: "large.md", mtime: 1, size: 11 }];
    ctx.deps.maxInputBytes = () => 10;
    ctx.deps.read = async (path) => {
      reads++;
      return ctx.files[path] ?? "";
    };

    const result = await new SemanticIndexer(ctx.deps).build({ force: true });

    expect(reads).toBe(0);
    expect(ctx.embedCalls).toEqual([]);
    expect(result).toMatchObject({ indexed: 0, skipped: 1, failureCount: 1 });
    expect(result.failures[0]?.message).toContain("exceeds the semantic indexing limit");
  });

  it("rejects an oversized incremental update before reading it", async () => {
    const ctx = makeDeps({ "large.pdf": "binary" });
    let reads = 0;
    ctx.deps.maxInputBytes = () => 10;
    ctx.deps.readPdfPages = async () => {
      reads++;
      return [{ page: 1, text: "cat" }];
    };
    const ix = new SemanticIndexer(ctx.deps);

    await expect(ix.updateNote("large.pdf", 1, 11)).rejects.toThrow("exceeds the semantic indexing limit");

    expect(reads).toBe(0);
    expect(ctx.embedCalls).toEqual([]);
  });

  it("does not live-read an oversized note for Related Notes", async () => {
    const ctx = makeDeps({ "indexed.md": "cat", "large.md": "dog" });
    let reads = 0;
    ctx.deps.listMarkdown = () => [
      { path: "indexed.md", mtime: 1, size: 3 },
      { path: "large.md", mtime: 1, size: 11 },
    ];
    ctx.deps.maxInputBytes = () => 10;
    ctx.deps.read = async (path) => {
      reads++;
      return ctx.files[path] ?? "";
    };
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build({ force: true });
    reads = 0;

    await expect(ix.related("large.md", 5)).rejects.toThrow("exceeds the semantic indexing limit");

    expect(reads).toBe(0);
  });

  it("prunes stale vectors when a previously indexed file grows oversized", async () => {
    const ctx = makeDeps({ "large.md": "cat" });
    let size = 3;
    ctx.deps.listMarkdown = () => [{ path: "large.md", mtime: 1, size }];
    ctx.deps.maxInputBytes = () => 10;
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build({ force: true });
    size = 11;
    ctx.files["large.md"] = "dog";

    const result = await ix.build({ force: true });

    expect(result).toMatchObject({ removed: 1, failureCount: 1 });
    expect((await ix.stats()).notes).toBe(0);
    expect(ctx.store.data?.notes).toEqual({});
  });

  it("prunes and persists stale vectors when an incremental file grows oversized", async () => {
    const ctx = makeDeps({ "large.md": "cat" });
    ctx.deps.maxInputBytes = () => 10;
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build({ force: true });

    await expect(ix.updateNote("large.md", 2, 11)).rejects.toThrow("exceeds the semantic indexing limit");

    expect((await ix.stats()).notes).toBe(0);
    expect(ctx.store.data?.notes).toEqual({});
  });

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

  it("bounds embedding batches when configured for a low-memory runtime", async () => {
    const ctx = makeDeps({ "large.md": "cat sentence. ".repeat(600) });
    Object.assign(ctx.deps, { embedBatchSize: 1 });

    await new SemanticIndexer(ctx.deps).build();

    expect(ctx.embedCalls.length).toBeGreaterThan(1);
    expect(ctx.embedCalls.every((batch) => batch.length === 1)).toBe(true);
  });

  it("never creates an empty inference batch from a positive fractional limit", async () => {
    const ctx = makeDeps({ "large.md": "cat sentence. ".repeat(600) });
    const embed = ctx.deps.embed;
    ctx.deps.embedBatchSize = 0.5;
    ctx.deps.embed = async (input) => {
      if (input.length === 0) throw new Error("empty inference batch");
      return embed(input);
    };

    const result = await new SemanticIndexer(ctx.deps).build();

    expect(result.failureCount).toBe(0);
    expect(ctx.embedCalls.length).toBeGreaterThan(1);
    expect(ctx.embedCalls.every((batch) => batch.length === 1)).toBe(true);
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

  it("indexes PDFs with page-locator chunks, skips unchanged, prunes removed", async () => {
    const ctx = makeDeps({ "cats.md": "# Cats\nThe feline cat is a small mammal." });
    const pdfPages = [
      { page: 1, text: "Cats are wonderful feline companions on page one." },
      { page: 2, text: "Fish appear on page two of this cat book." },
    ];
    let pdfs: IndexFile[] = [{ path: "book.pdf", mtime: 1 }];
    ctx.deps.listPdf = () => pdfs;
    const pdfReads: string[] = [];
    ctx.deps.readPdfPages = async (path: string) => {
      pdfReads.push(path);
      return path === "book.pdf" ? pdfPages : null;
    };

    const ix = new SemanticIndexer(ctx.deps);
    const res = await ix.build();
    expect(res.indexed).toBe(2); // the note + the pdf

    const hits = await ix.search("feline companion", 3);
    expect(hits[0]?.path).toBe("cats.md");
    const pdfHit = hits.find((h) => h.path === "book.pdf");
    expect(pdfHit?.text).toContain("Page 1");

    // Rebuild: unchanged pdf skipped (no re-read needed for embedding).
    const before = ctx.embedCalls.length;
    const res2 = await ix.build();
    expect(res2.indexed).toBe(0);
    expect(ctx.embedCalls.length).toBe(before);

    // PDF leaves the vault → pruned from the store.
    pdfs = [];
    const res3 = await ix.build();
    expect(res3.removed).toBe(1);
    expect((await ix.search("feline", 5)).every((h) => h.path !== "book.pdf")).toBe(true);
  });

  it("updateNote re-embeds a changed PDF and skips it without the pdf deps", async () => {
    const ctx = makeDeps({});
    let text = "Cats on page one.";
    ctx.deps.listPdf = () => [{ path: "doc.pdf", mtime: 1 }];
    ctx.deps.readPdfPages = async () => [{ page: 1, text }];
    const ix = new SemanticIndexer(ctx.deps);
    await ix.build();
    expect((await ix.search("cat", 1))[0]?.path).toBe("doc.pdf");

    text = "Fish swim in the ocean.";
    await ix.updateNote("doc.pdf", 2);
    expect((await ix.search("ocean fish", 1))[0]?.path).toBe("doc.pdf");

    // Without readPdfPages the pdf is simply not indexed.
    const plain = makeDeps({});
    const ix2 = new SemanticIndexer(plain.deps);
    await ix2.updateNote("other.pdf", 1);
    expect(await ix2.search("anything", 1)).toEqual([]);
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

  it("reports embed phases per batch through onPhase", async () => {
    const ctx = makeDeps({ "a.md": "cat cat cat cat" });
    const phases: Array<{ phase: string; chunks: number }> = [];
    ctx.deps.embedBatchSize = 1;
    ctx.deps.onPhase = (phase, fields) => { phases.push({ phase, chunks: fields.chunks }); };
    const ix = new SemanticIndexer(ctx.deps);
    await ix.updateNote("a.md", 1);
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases[0]?.phase).toBe("embed-start");
    expect(phases[phases.length - 1]?.phase).toBe("embed-done");
    expect(phases.every((p) => p.chunks === 1)).toBe(true);
  });

  it("updateNotes embeds every note and saves once", async () => {
    const ctx = makeDeps({ "a.md": "cat", "b.md": "dog", "c.md": "fish" });
    let saves = 0;
    const save = ctx.deps.save;
    ctx.deps.save = async (d) => { saves++; await save(d); };
    const ix = new SemanticIndexer(ctx.deps);
    await ix.updateNotes([{ path: "a.md", mtime: 1 }, { path: "b.md", mtime: 1 }, { path: "c.md", mtime: 1 }]);
    expect(ctx.embedCalls.length).toBe(3);
    expect(saves).toBe(1);
    expect(Object.keys(ctx.store.data?.notes ?? {}).sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("updateNotes calls yieldBetween between notes, not after the last", async () => {
    const ctx = makeDeps({ "a.md": "cat", "b.md": "dog", "c.md": "fish" });
    const ix = new SemanticIndexer(ctx.deps);
    const yieldBetween = vi.fn(async () => {});
    await ix.updateNotes(
      [{ path: "a.md", mtime: 1 }, { path: "b.md", mtime: 1 }, { path: "c.md", mtime: 1 }],
      { yieldBetween },
    );
    expect(yieldBetween).toHaveBeenCalledTimes(2);
  });

  it("updateNotes reports an oversized entry as a failure, removes it, and still indexes the rest", async () => {
    const ctx = makeDeps({ "large.md": "cat", "b.md": "dog", "c.md": "fish" });
    ctx.deps.maxInputBytes = () => 10;
    let saves = 0;
    const save = ctx.deps.save;
    ctx.deps.save = async (d) => { saves++; await save(d); };
    const ix = new SemanticIndexer(ctx.deps);
    await ix.updateNote("large.md", 1, 3);

    const failures = await ix.updateNotes([
      { path: "large.md", mtime: 2, size: 11 },
      { path: "b.md", mtime: 1 },
      { path: "c.md", mtime: 1 },
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.path).toBe("large.md");
    expect(saves).toBe(2);
    expect(Object.keys(ctx.store.data?.notes ?? {}).sort()).toEqual(["b.md", "c.md"]);
  });
});
