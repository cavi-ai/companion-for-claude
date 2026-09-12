import { describe, it, expect, vi } from "vitest";
vi.mock("obsidian", async (importOriginal) => ({ ...await importOriginal<typeof import("obsidian")>(), PluginSettingTab: class {} }));
import { App } from "obsidian";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import { embedderId } from "../src/semantic/embedder";
import { EnrichDiagnostics } from "../src/sources/enrichDiagnostics";

type Reindexable = {
  queueReindex(path: string): void;
  flushReindex(): Promise<void>;
  suspendReindex(): () => void;
  reindexQueue: Set<string>;
  _indexer: { updateNotes: ReturnType<typeof vi.fn>; updateNote: ReturnType<typeof vi.fn> } | null;
  indexerModel: string | null;
  canEmbedWithoutDownload(): Promise<boolean>;
};

function makePlugin(): { plugin: ClaudeCompanionPlugin; p: Reindexable; app: App } {
  const app = new App();
  const plugin = new ClaudeCompanionPlugin(app as never, { id: "claude-companion", name: "t", version: "0.0.0", minAppVersion: "1.13.0", author: "", description: "" } as never);
  Object.assign(plugin, { app });
  plugin.settings = { ...DEFAULT_SETTINGS, semanticEnabled: true };
  const p = plugin as unknown as Reindexable;
  p._indexer = { updateNotes: vi.fn(async () => []), updateNote: vi.fn(async () => {}) };
  // Matches indexer()'s short-circuit so the flush reuses this stub instead of building a real one.
  p.indexerModel = embedderId(plugin.settings.embeddingEngine, plugin.settings.embeddingModel, plugin.settings.builtinEmbeddingModel, plugin.settings.openaiCompatEmbeddingModel);
  p.canEmbedWithoutDownload = async () => true;
  return { plugin, p, app };
}

describe("reindex suspension", () => {
  it("defers the flush while suspended and runs one updateNotes on release", async () => {
    const { p, app } = makePlugin();
    app.vault.create("a.md", "a"); app.vault.create("b.md", "b");
    const release = p.suspendReindex();
    p.reindexQueue.add("a.md"); p.reindexQueue.add("b.md");
    await p.flushReindex();
    expect(p._indexer!.updateNotes).not.toHaveBeenCalled();
    expect(p.reindexQueue.size).toBe(2);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(p._indexer!.updateNotes).toHaveBeenCalledTimes(1);
    expect(p._indexer!.updateNotes.mock.calls[0][0]).toHaveLength(2);
    expect(p.reindexQueue.size).toBe(0);
  });

  it("releasing twice is harmless and nested holds flush on the last release", async () => {
    const { p, app } = makePlugin();
    app.vault.create("a.md", "a");
    const r1 = p.suspendReindex(); const r2 = p.suspendReindex();
    p.reindexQueue.add("a.md");
    r1(); r1();
    await p.flushReindex();
    expect(p._indexer!.updateNotes).not.toHaveBeenCalled();
    r2();
    await new Promise((r) => setTimeout(r, 0));
    expect(p._indexer!.updateNotes).toHaveBeenCalledTimes(1);
  });

  it("when updateNotes rejects, raises recovery activity per note and resolves without throwing", async () => {
    const { plugin, p, app } = makePlugin();
    const lines: string[] = [];
    const diagnostics = new EnrichDiagnostics({
      append: async (_path, line) => { lines.push(line); },
      now: () => 1_700_000_000_000,
      isMobile: false,
      path: "Claude/enrichment-diagnostics.log",
    }, () => true);
    (plugin as unknown as { _enrichDiagnostics: EnrichDiagnostics })._enrichDiagnostics = diagnostics;
    app.vault.create("a.md", "a");
    app.vault.create("b.md", "b");
    p.reindexQueue.add("a.md");
    p.reindexQueue.add("b.md");
    p._indexer!.updateNotes = vi.fn().mockRejectedValue(new Error("disk full"));

    await p.flushReindex();

    const records = plugin.activity.snapshot().records;
    expect(records).toHaveLength(2);
    expect(records[0]?.id).toMatch(/^semantic-index:incremental:/);
    expect(records[1]?.id).toMatch(/^semantic-index:incremental:/);
    expect(records[0]?.state).toBe("needs-attention");
    expect(records[1]?.state).toBe("needs-attention");
    await Promise.resolve();
    expect(lines).toEqual([
      "2023-11-14T22:13:20.000Z desktop reindex-flush-start n=2\n",
      "2023-11-14T22:13:20.000Z desktop reindex-flush-rejected n=2\n",
    ]);
  });
});
