import { describe, it, expect, vi } from "vitest";
import { SemanticController, type SemanticControllerDeps } from "../src/semantic/controller";
import { DEFAULT_SETTINGS } from "../src/types";
import { embedderId } from "../src/semantic/embedder";

function makeDeps(filePaths: string[], overrides?: Partial<SemanticControllerDeps>): SemanticControllerDeps {
  const settings = { ...DEFAULT_SETTINGS, semanticEnabled: true };
  const now = Date.now();
  const files = new Map(filePaths.map((p) => [p, { path: p, stat: { mtime: now, size: 100 } }]));
  return {
    settings: () => settings,
    saveSettings: async () => {},
    manifestDir: ".obsidian/plugins/claude-companion",
    manifestId: "claude-companion",
    activity: () => ({
      start: vi.fn(() => "act-1"),
      update: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
      snapshot: () => ({ records: [] }),
    }) as never,
    enrichDiagnostics: () => ({ log: vi.fn() }) as never,
    router: () => ({ ollama: { hasCredentials: () => true, embed: vi.fn() } }) as never,
    isMobile: false,
    vault: {
      adapterExists: async () => false,
      adapterRead: async () => "{}",
      adapterWrite: async () => {},
      getMarkdownFiles: () => Array.from(files.values()),
      getPdfFiles: () => [],
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      cachedRead: async () => "",
      readBinary: async () => new ArrayBuffer(0),
    },
    notice: vi.fn(),
    openChoiceModal: vi.fn(),
    mobileSourceNoteMaxBytes: 500_000,
    mobilePdfMaxBytes: 2_000_000,
    ...overrides,
  };
}

type ControllerInternals = {
  _indexer: { updateNotes: ReturnType<typeof vi.fn> } | null;
  indexerModel: string | null;
  reindexQueue: Set<string>;
  reindexSuspended: number;
  flushReindex(): Promise<void>;
};

function makeController(filePaths: string[]): { ctrl: SemanticController; internal: ControllerInternals } {
  const deps = makeDeps(filePaths);
  const ctrl = new SemanticController(deps);
  const model = embedderId(
    deps.settings().embeddingEngine,
    deps.settings().embeddingModel,
    deps.settings().builtinEmbeddingModel,
    deps.settings().openaiCompatEmbeddingModel,
  );
  const internal = ctrl as unknown as ControllerInternals;
  internal._indexer = { updateNotes: vi.fn(async () => []) };
  internal.indexerModel = model;
  (ctrl as unknown as { canEmbedWithoutDownload: () => Promise<boolean> }).canEmbedWithoutDownload = async () => true;
  return { ctrl, internal };
}

describe("reindex suspension", () => {
  it("defers the flush while suspended and runs one updateNotes on release", async () => {
    const { ctrl, internal } = makeController(["a.md", "b.md"]);
    const release = ctrl.suspendReindex();
    internal.reindexQueue.add("a.md");
    internal.reindexQueue.add("b.md");
    await internal.flushReindex();
    expect(internal._indexer!.updateNotes).not.toHaveBeenCalled();
    expect(internal.reindexQueue.size).toBe(2);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(internal._indexer!.updateNotes).toHaveBeenCalledTimes(1);
    expect(internal._indexer!.updateNotes.mock.calls[0][0]).toHaveLength(2);
    expect(internal.reindexQueue.size).toBe(0);
  });

  it("releasing twice is harmless and nested holds flush on the last release", async () => {
    const { ctrl, internal } = makeController(["a.md"]);
    const r1 = ctrl.suspendReindex();
    const r2 = ctrl.suspendReindex();
    internal.reindexQueue.add("a.md");
    r1(); r1();
    await internal.flushReindex();
    expect(internal._indexer!.updateNotes).not.toHaveBeenCalled();
    r2();
    await new Promise((r) => setTimeout(r, 0));
    expect(internal._indexer!.updateNotes).toHaveBeenCalledTimes(1);
  });

  it("when updateNotes rejects, raises recovery activity per note and resolves without throwing", async () => {
    const failedActivities: Array<{ id: string; failed: number }> = [];
    const diagLines: string[] = [];
    const deps = makeDeps(["a.md", "b.md"], {
      activity: () => ({
        start: vi.fn((opts: { id: string }) => opts.id),
        update: vi.fn(),
        finish: vi.fn(),
        fail: vi.fn((id: string, data: { failed: number }) => { failedActivities.push({ id, ...data }); }),
        snapshot: () => ({ records: failedActivities.map((a) => ({ ...a, state: "needs-attention" })) }),
      }) as never,
      enrichDiagnostics: () => ({ log: (phase: string) => { diagLines.push(phase); } }) as never,
    });
    const ctrl = new SemanticController(deps);
    const model = embedderId(
      deps.settings().embeddingEngine,
      deps.settings().embeddingModel,
      deps.settings().builtinEmbeddingModel,
      deps.settings().openaiCompatEmbeddingModel,
    );
    const internal = ctrl as unknown as ControllerInternals;
    internal._indexer = { updateNotes: vi.fn().mockRejectedValue(new Error("disk full")) };
    internal.indexerModel = model;
    (ctrl as unknown as { canEmbedWithoutDownload: () => Promise<boolean> }).canEmbedWithoutDownload = async () => true;
    internal.reindexQueue.add("a.md");
    internal.reindexQueue.add("b.md");

    await internal.flushReindex();

    expect(failedActivities).toHaveLength(2);
    expect(failedActivities[0]?.id).toMatch(/^semantic-index:incremental:/);
    expect(failedActivities[1]?.id).toMatch(/^semantic-index:incremental:/);
    expect(diagLines).toContain("reindex-flush-start");
    expect(diagLines).toContain("reindex-flush-rejected");
  });
});
