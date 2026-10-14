import { describe, expect, it } from "vitest";
import { SemanticIndexer, type IndexBuildProgress } from "../src/semantic/indexer";
import { estimatedRemainingMs, formatIndexProgress, type SemanticIndexProgress } from "../src/semantic/progress";

const progress: SemanticIndexProgress = {
  state: "running", phase: "embedding", startedAt: 0,
  filesCompleted: 3, totalFiles: 10, chunksEmbedded: 35, completedFileChunks: 30,
  currentFileChunksCompleted: 5, currentFileChunksTotal: 20,
};

describe("semantic rebuild progress", () => {
  it("reports successful batches while a long note is still embedding", async () => {
    const events: IndexBuildProgress[] = [];
    const index = new SemanticIndexer({
      embeddingModel: "test", listMarkdown: () => [{ path: "long.md", mtime: 1 }],
      read: async () => "a".repeat(1600), embedBatchSize: 1,
      embed: async (texts) => texts.map(() => [1, 0]), load: async () => null,
      save: async () => { expect(events.at(-1)?.phase).toBe("saving"); },
    });
    await index.build({ onDetailedProgress: (event) => events.push(event) });
    expect(events).toContainEqual(expect.objectContaining({
      phase: "embedding", filesCompleted: 0, totalFiles: 1,
      chunksEmbedded: 1, currentFileChunksCompleted: 1, currentFileChunksTotal: 2,
    }));
    expect(events.at(-1)).toMatchObject({ filesCompleted: 1, chunksEmbedded: 2, completedFileChunks: 2 });
    // Earlier snapshots must stay independent of subsequent counter updates.
    expect(events[0]?.chunksEmbedded).toBe(0);
  });

  it("does not count a failed embedding batch", async () => {
    const events: IndexBuildProgress[] = [];
    const index = new SemanticIndexer({
      embeddingModel: "test", listMarkdown: () => [{ path: "note.md", mtime: 1 }],
      read: async () => "a note", embed: async () => { throw new Error("engine failed"); },
      load: async () => null, save: async () => {},
    });
    const result = await index.build({ onDetailedProgress: (event) => events.push(event) });
    expect(result.aborted).toBe(true);
    expect(events.every((event) => event.chunksEmbedded === 0)).toBe(true);
  });

  it("estimates remaining chunks from completed notes and the current note", () => {
    expect(estimatedRemainingMs(progress, 70_000)).toBe(150_000);
    expect(formatIndexProgress(progress, 70_000)).toBe("35 chunks embedded · 3/10 notes\nElapsed: 1m 10s\nEstimated remaining: ~2m 30s");
  });

  it("waits for a useful sample and never reports zero remaining while saving", () => {
    expect(estimatedRemainingMs({ ...progress, filesCompleted: 1 }, 70_000)).toBeNull();
    expect(formatIndexProgress({ ...progress, filesCompleted: 1 }, 70_000)).toContain("Estimated remaining: Estimating…");
    expect(formatIndexProgress({ ...progress, phase: "saving" }, 70_000)).toContain("Estimated remaining: Saving index…");
  });

  it("freezes elapsed time when the operation ends", () => {
    expect(formatIndexProgress({ ...progress, state: "succeeded", finishedAt: 70_000 }, 120_000)).toContain("Elapsed: 1m 10s");
  });
});
