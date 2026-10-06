import { describe, expect, it, vi } from "vitest";
import { SemanticIndexer, type IndexerDeps } from "../src/semantic/indexer";
import { SemanticStore } from "../src/semantic/store";
import { SemanticController, type SemanticControllerDeps } from "../src/semantic/controller";
import { DEFAULT_SETTINGS } from "../src/types";

function deps(overrides: Partial<IndexerDeps> = {}): IndexerDeps {
  return {
    embeddingModel: "test", listMarkdown: () => [{ path: "A.md", mtime: 1 }],
    read: async () => "Alpha", embed: async (texts) => texts.map(() => [1, 0]),
    load: async () => null, save: async () => {}, ...overrides,
  };
}

describe("semantic resilience", () => {
  it("does not restart inference or save after lifecycle cancellation", async () => {
    const abort = new AbortController();
    const save = vi.fn();
    const embed = vi.fn(async () => { abort.abort(); return [[1, 0]]; });
    const index = new SemanticIndexer(deps({ signal: abort.signal, embed, save }));
    await expect(index.build()).rejects.toThrow();
    await expect(index.build()).rejects.toThrow();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("checks the total chunk budget before inference", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    const index = new SemanticIndexer(deps({ maxChunks: 1, embed, listMarkdown: () => [{ path: "A.md", mtime: 1 }, { path: "B.md", mtime: 1 }] }));
    const result = await index.build();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.failureCount).toBe(1);
    expect((await index.stats()).chunks).toBe(1);
  });

  it("uses query encoding for search and document encoding for stored notes", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    const embedQuery = vi.fn(async () => [[1, 0]]);
    const index = new SemanticIndexer(deps({ embed, embedQuery }));
    await index.build();
    expect((await index.search("find alpha", 1))[0]?.path).toBe("A.md");
    expect(embed).toHaveBeenCalledExactlyOnceWith(["Alpha"]);
    expect(embedQuery).toHaveBeenCalledExactlyOnceWith("find alpha");
  });
  it("shares one persisted load across concurrent readers", async () => {
    const load = vi.fn(async () => null);
    const index = new SemanticIndexer(deps({ load }));
    await Promise.all([index.stats(), index.noteVectors(), index.relatedStored("A.md", 3)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not serialize an unchanged index", async () => {
    const save = vi.fn();
    const index = new SemanticIndexer(deps({ save }));
    await index.build();
    save.mockClear();
    await index.build();
    expect(save).not.toHaveBeenCalled();
  });

  it("stops the batch after an embedding engine failure", async () => {
    const embed = vi.fn(async () => { throw new Error("embedding worker crashed"); });
    const index = new SemanticIndexer(deps({ embed, listMarkdown: () => ["A", "B", "C"].map((p) => ({ path: `${p}.md`, mtime: 1 })) }));
    const result = await index.build();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.failureCount).toBe(1);
  });

  it.each([null, { ord: 0, text: "Alpha", vector: [NaN, 0] }, { ord: 0, text: "Alpha", vector: [1] }])("rejects corrupt persisted chunks %j", (chunk) => {
    const store = SemanticStore.load({ version: 1, model: "test", dim: 2, notes: { "A.md": { hash: "a", mtime: 1, chunks: [chunk] } } }, "test");
    expect(store.stats().chunks).toBe(0);
    expect(store.search([1, 0], 3)).toEqual([]);
  });

  it("does not touch the index or load a model during mobile startup", async () => {
    const controller = new SemanticController({
      settings: () => ({ ...DEFAULT_SETTINGS, semanticEnabled: true }), isMobile: true,
    } as SemanticControllerDeps);
    const indexer = vi.spyOn(controller, "indexer");
    const cached = vi.spyOn(controller, "canEmbedWithoutDownload");
    await controller.catchUpIndex();
    expect(indexer).not.toHaveBeenCalled();
    expect(cached).not.toHaveBeenCalled();
  });

  it("terminates the built-in worker when semantic search is disabled", () => {
    const settings = { ...DEFAULT_SETTINGS, semanticEnabled: true };
    const controller = new SemanticController({ settings: () => settings } as SemanticControllerDeps);
    const embedder = controller.builtinEmbedder();
    const terminate = vi.spyOn(embedder, "terminate");
    settings.semanticEnabled = false;
    controller.onSettingsChanged();
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
