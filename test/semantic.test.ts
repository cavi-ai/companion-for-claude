import { describe, it, expect } from "vitest";
import { chunkNote, stripFrontmatter, contentHash } from "../src/semantic/chunk";
import { cosineSimilarity, topKByVector, reciprocalRankFusion } from "../src/semantic/similarity";
import { SemanticStore, emptyIndex, INDEX_VERSION } from "../src/semantic/store";

describe("chunk", () => {
  it("strips frontmatter", () => {
    const md = "---\ntitle: X\ntags: [a]\n---\nBody here";
    expect(stripFrontmatter(md)).toBe("Body here");
  });

  it("returns [] for empty / frontmatter-only notes", () => {
    expect(chunkNote("")).toEqual([]);
    expect(chunkNote("---\ntitle: X\n---\n")).toEqual([]);
  });

  it("splits by heading and carries the heading into body chunks", () => {
    const md = "# Intro\nalpha text\n\n## Details\nbeta text";
    const chunks = chunkNote(md, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.heading)).toContain("Details");
    // A body chunk under "Details" includes the heading for context.
    const details = chunks.find((c) => c.heading === "Details");
    expect(details?.text).toContain("Details");
    expect(details?.text).toContain("beta text");
  });

  it("size-caps long sections with ordered chunks", () => {
    const long = "word ".repeat(2000); // ~10k chars, no headings
    const chunks = chunkNote(long, { maxChars: 1500, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.text.length <= 1700)).toBe(true);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it("contentHash is stable and change-sensitive", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("similarity", () => {
  it("cosine: identical=1, orthogonal=0, opposite=-1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("cosine: zero vector → 0 (no NaN)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("topKByVector ranks by closeness", () => {
    const items = [
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0.9, 0.1] },
      { id: "c", vector: [0, 1] },
    ];
    const top = topKByVector([1, 0], items, 2);
    expect(top.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("reciprocalRankFusion rewards items ranked high across lists", () => {
    const keyword = [{ id: "x", score: 9 }, { id: "y", score: 8 }];
    const semantic = [{ id: "y", score: 0.9 }, { id: "z", score: 0.8 }];
    const fused = reciprocalRankFusion([keyword, semantic]);
    // y appears high in both → should win.
    expect(fused[0].id).toBe("y");
    expect(fused.map((r) => r.id).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("SemanticStore", () => {
  it("upsert / needsReindex / search best-chunk-per-note", () => {
    const store = new SemanticStore(emptyIndex("nomic"));
    store.upsertNote("A.md", "h1", 1, [
      { ord: 0, text: "cats", vector: [1, 0] },
      { ord: 1, text: "dogs", vector: [0, 1] },
    ]);
    store.upsertNote("B.md", "h2", 1, [{ ord: 0, text: "fish", vector: [0.2, 0.98] }]);

    expect(store.needsReindex("A.md", "h1")).toBe(false);
    expect(store.needsReindex("A.md", "changed")).toBe(true);
    expect(store.needsReindex("C.md", "h3")).toBe(true);

    const hits = store.search([1, 0], 5);
    expect(hits[0].path).toBe("A.md"); // best chunk = "cats" [1,0]
    expect(hits[0].text).toBe("cats");
    // note-deduped: A appears once even though it has 2 chunks
    expect(hits.filter((h) => h.path === "A.md").length).toBe(1);
  });

  it("remove / rename / prune", () => {
    const store = new SemanticStore(emptyIndex("nomic"));
    store.upsertNote("A.md", "h", 1, [{ ord: 0, text: "x", vector: [1] }]);
    store.upsertNote("B.md", "h", 1, [{ ord: 0, text: "y", vector: [1] }]);
    store.renameNote("A.md", "A2.md");
    expect(store.hasNote("A.md")).toBe(false);
    expect(store.hasNote("A2.md")).toBe(true);
    store.removeNote("A2.md");
    expect(store.hasNote("A2.md")).toBe(false);
    const pruned = store.pruneTo(new Set(["B.md"]));
    expect(pruned).toBe(0);
    expect(store.pruneTo(new Set<string>())).toBe(1); // removes B
  });

  it("noteVector centroid + related excludes self", () => {
    const store = new SemanticStore(emptyIndex("nomic"));
    store.upsertNote("A.md", "h", 1, [
      { ord: 0, text: "x", vector: [1, 0] },
      { ord: 1, text: "y", vector: [0, 0] },
    ]);
    store.upsertNote("B.md", "h", 1, [{ ord: 0, text: "z", vector: [0.9, 0.1] }]);
    store.upsertNote("C.md", "h", 1, [{ ord: 0, text: "w", vector: [0, 1] }]);

    expect(store.noteVector("A.md")).toEqual([0.5, 0]); // centroid of [1,0] and [0,0]
    expect(store.noteVector("missing.md")).toBeNull();

    const rel = store.related("A.md", 5);
    expect(rel.map((r) => r.path)).not.toContain("A.md"); // self excluded
    expect(rel[0].path).toBe("B.md"); // nearest to A's centroid
  });

  it("load: rejects stale version or model mismatch", () => {
    const good = new SemanticStore(emptyIndex("nomic"));
    good.upsertNote("A.md", "h", 1, [{ ord: 0, text: "x", vector: [1, 2] }]);
    const json = good.toJSON();

    const same = SemanticStore.load(json, "nomic");
    expect(same.hasNote("A.md")).toBe(true);

    const modelChanged = SemanticStore.load(json, "other-model");
    expect(modelChanged.hasNote("A.md")).toBe(false); // invalidated

    const stale = SemanticStore.load({ ...json, version: INDEX_VERSION + 1 }, "nomic");
    expect(stale.hasNote("A.md")).toBe(false);

    expect(SemanticStore.load(null, "nomic").stats().notes).toBe(0);
  });
});
