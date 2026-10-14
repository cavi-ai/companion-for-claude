import { describe, expect, it, vi } from "vitest";
import { SemanticStore } from "../src/semantic/store";
import { SemanticIndexer } from "../src/semantic/indexer";

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const chunk = { ord: 0, text: '雪 🦊 "quoted"\n' + "a".repeat(500) };
const vector = [1, 0, 0];

describe("semantic serialized budget", () => {
  it("predicts the complete UTF-8 size without encoding vectors", () => {
    const store = SemanticStore.load(null, 'model "雪"');
    const predict = (path: string) => store.projectedSerializedBytes(path, "hash", 123, [chunk], vector.length);
    const predicted = predict('folder/雪 "note".md');
    store.upsertNote('folder/雪 "note".md', "hash", 123, [{ ...chunk, vector }]);
    expect(predicted).toBe(bytes(store.toJSON()));
    // Exercise the cached size through every mutation that changes JSON.
    store.markCurrent('folder/雪 "note".md', 1234567);
    store.renameNote('folder/雪 "note".md', "renamed.md");
    const next = predict("next.md");
    store.upsertNote("next.md", "hash", 123, [{ ...chunk, vector }]);
    expect(next).toBe(bytes(store.toJSON()));
    store.removeNote("renamed.md");
    store.pruneTo(new Set());
    const emptyPrediction = predict("new.md");
    store.upsertNote("new.md", "hash", 123, [{ ...chunk, vector }]);
    expect(emptyPrediction).toBe(bytes(store.toJSON()));
  });

  it("stops before embedding a note that cannot fit and retains the saved index", async () => {
    const original = SemanticStore.load(null, "test");
    original.upsertNote("old.md", "hash", 1, [{ ord: 0, text: "old", vector }]);
    const saved = original.toJSON();
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
    const save = vi.fn();
    const index = new SemanticIndexer({
      embeddingModel: "test", embeddingDimensions: 3, maxSerializedBytes: 400,
      listMarkdown: () => [{ path: "first.md", mtime: 1 }, { path: "large.md", mtime: 1 }],
      read: async (path) => path === "first.md" ? "small" : "a".repeat(700),
      embed, load: async () => saved, save,
    });
    await expect(index.build({ force: true })).rejects.toThrow("persistence budget");
    expect(embed).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(await index.stats()).toEqual({ notes: 1, chunks: 1 });
  });

  it("checks unknown endpoint dimensions after its first batch", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(384).fill(0)));
    const save = vi.fn();
    const index = new SemanticIndexer({
      embeddingModel: "test", maxSerializedBytes: 1000, embedBatchSize: 1,
      listMarkdown: () => [{ path: "large.md", mtime: 1 }], read: async () => "a".repeat(2400),
      embed, load: async () => null, save,
    });
    await expect(index.build()).rejects.toThrow("persistence budget");
    expect(embed).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves the saved index when the vector chunk cap would also be exceeded", async () => {
    const embed = vi.fn(async () => [vector]);
    const save = vi.fn();
    const index = new SemanticIndexer({
      embeddingModel: "test", embeddingDimensions: 3, maxSerializedBytes: 400, maxChunks: 1,
      listMarkdown: () => [{ path: "large.md", mtime: 1 }], read: async () => "a".repeat(2400),
      embed, load: async () => null, save,
    });
    await expect(index.build()).rejects.toThrow("persistence budget");
    expect(embed).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("rolls back an incremental batch when a later note exceeds the budget", async () => {
    const original = SemanticStore.load(null, "test");
    original.upsertNote("old.md", "hash", 1, [{ ord: 0, text: "old", vector }]);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => vector));
    const save = vi.fn();
    const index = new SemanticIndexer({
      embeddingModel: "test", embeddingDimensions: 3, maxSerializedBytes: 400,
      listMarkdown: () => [], read: async (path) => path === "first.md" ? "small" : "a".repeat(700),
      embed, load: async () => original.toJSON(), save,
    });
    await expect(index.updateNotes([{ path: "first.md", mtime: 1 }, { path: "large.md", mtime: 1 }]))
      .rejects.toThrow("persistence budget");
    expect(embed).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(await index.stats()).toEqual({ notes: 1, chunks: 1 });
  });
});
