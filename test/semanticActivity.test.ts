import { App, clearNotices, FakeElement, WorkspaceLeaf } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import type { BuildResult } from "../src/semantic/indexer";
import { RelatedView } from "../src/view/RelatedView";
import { SemanticController, type SemanticControllerDeps } from "../src/semantic/controller";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function makeDeps(overrides?: Partial<SemanticControllerDeps>): SemanticControllerDeps {
  const settings = { ...DEFAULT_SETTINGS, semanticEnabled: true };
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
    router: () => ({ ollama: { hasCredentials: () => true }, localAvailable: async () => true }) as never,
    isMobile: false,
    vault: {
      adapterExists: async () => false,
      adapterRead: async () => "{}",
      adapterWrite: async () => {},
      getMarkdownFiles: () => [],
      getPdfFiles: () => [],
      getAbstractFileByPath: () => null,
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

describe("semantic activity", () => {
  beforeEach(() => clearNotices());

  it("moves determinate index progress and partial failures out of blocking Notices", async () => {
    const activityRecords: Array<Record<string, unknown>> = [];
    const completion = deferred<BuildResult>();
    const build = vi.fn(async ({ onProgress }: { onProgress(done: number, total: number): void }) => {
      onProgress(2, 4);
      return completion.promise;
    });
    const deps = makeDeps({
      settings: () => ({ ...DEFAULT_SETTINGS, semanticEnabled: true, embeddingEngine: "ollama" } as ReturnType<SemanticControllerDeps["settings"]>),
      router: () => ({ ollama: { hasCredentials: () => true }, localAvailable: async () => true }) as never,
      activity: () => ({
        start: vi.fn((opts: Record<string, unknown>) => { activityRecords.push({ ...opts, state: "running", completed: 0 }); return opts.id; }),
        update: vi.fn((_id: string, data: Record<string, unknown>) => { Object.assign(activityRecords[0]!, data); }),
        finish: vi.fn((_id: string, data: Record<string, unknown>) => { Object.assign(activityRecords[0]!, data, { state: "finished" }); }),
        fail: vi.fn((_id: string, data: Record<string, unknown>) => { Object.assign(activityRecords[0]!, data, { state: "needs-attention" }); }),
        snapshot: () => ({ records: activityRecords }),
      }) as never,
    });
    const ctrl = new SemanticController(deps);
    (ctrl as unknown as { indexer: () => { build: typeof build } }).indexer = () => ({ build });

    const running = ctrl.rebuildSemanticIndex();
    await Promise.resolve();
    expect(activityRecords[0]).toMatchObject({ completed: 2, total: 4, state: "running" });

    completion.resolve({
      indexed: 3,
      skipped: 1,
      removed: 0,
      failureCount: 1,
      failures: [{ path: "Research/broken.md", message: "Ollama refused connection" }],
    });
    await running;

    expect(activityRecords[0]).toMatchObject({ state: "needs-attention", succeeded: 3, failed: 1 });
    expect((activityRecords[0] as { details?: Array<{ label: string; message: string; state: string }> }).details).toEqual([
      { label: "Research/broken.md", message: "Ollama refused connection", state: "error" },
    ]);
  });

  it("renders actionable embedding recovery inside Related Notes", async () => {
    const app = new App();
    const file = app.vault.seed("Research/active.md", "Active note");
    Object.assign(app.workspace, { getActiveFile: () => file });
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    const runActivityRecovery = vi.fn().mockResolvedValue(undefined);
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app,
      manifest: { id: "claude-companion", dir: ".obsidian/plugins/claude-companion" },
      settings: { ...structuredClone(DEFAULT_SETTINGS), semanticEnabled: true, embeddingEngine: "ollama" },
      ontology: () => null,
      linkCandidates: () => [],
      linkedTargets: () => [],
      relatedNotes: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); },
      runActivityRecovery,
    });
    const view = new RelatedView(new WorkspaceLeaf(app), plugin);

    await view.render();

    const root = view.contentEl as unknown as FakeElement;
    expect(root.querySelector(".cc-embedding-recovery-message")?.textContent).toContain("Companion cannot reach Ollama");
    const retry = root.querySelectorAll("button").find(({ textContent }) => textContent === "Retry connection and index");
    expect(retry).toBeDefined();
    retry?.dispatchEvent({ type: "click" });
    expect(runActivityRecovery).toHaveBeenCalledWith(expect.stringContaining("semantic-related:"), "retry-index");
    expect(plugin.activity.snapshot().records[0]?.state).toBe("needs-attention");
  });

  it("passes the current file size into incremental indexing", async () => {
    const app = new App();
    const file = app.vault.seed("Research/active.md", "Active note");
    const updateNotes = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({
      vault: {
        adapterExists: async () => false,
        adapterRead: async () => "{}",
        adapterWrite: async () => {},
        getMarkdownFiles: () => [],
        getPdfFiles: () => [],
        getAbstractFileByPath: (p: string) => p === file.path ? { path: file.path, stat: { mtime: file.stat.mtime, size: file.stat.size } } : null,
        cachedRead: async () => "",
        readBinary: async () => new ArrayBuffer(0),
      },
    });
    const ctrl = new SemanticController(deps);
    const internal = ctrl as unknown as {
      reindexQueue: Set<string>;
      reindexTimer: number | null;
      flushReindex(): Promise<void>;
    };
    internal.reindexQueue.add(file.path);
    internal.reindexTimer = null;
    (ctrl as unknown as { indexer: () => { updateNotes: typeof updateNotes } }).indexer = () => ({ updateNotes });
    (ctrl as unknown as { canEmbedWithoutDownload: () => Promise<boolean> }).canEmbedWithoutDownload = async () => true;

    await internal.flushReindex();

    expect(updateNotes).toHaveBeenCalledWith(
      [{ path: file.path, mtime: file.stat.mtime, size: file.stat.size }],
      {},
    );
  });

  it("records incremental indexing failures for recovery", async () => {
    const app = new App();
    const file = app.vault.seed("Research/active.md", "Active note");
    const failedActivities: Array<{ id: string; failed: number; details: unknown[] }> = [];
    const deps = makeDeps({
      vault: {
        adapterExists: async () => false,
        adapterRead: async () => "{}",
        adapterWrite: async () => {},
        getMarkdownFiles: () => [],
        getPdfFiles: () => [],
        getAbstractFileByPath: (p: string) => p === file.path ? { path: file.path, stat: { mtime: file.stat.mtime, size: file.stat.size } } : null,
        cachedRead: async () => "",
        readBinary: async () => new ArrayBuffer(0),
      },
      activity: () => ({
        start: vi.fn((opts: { id: string }) => opts.id),
        update: vi.fn(),
        finish: vi.fn(),
        fail: vi.fn((id: string, data: { failed: number; details: unknown[] }) => { failedActivities.push({ id, ...data }); }),
        snapshot: () => ({ records: failedActivities.map((a) => ({ ...a, state: "needs-attention" })) }),
      }) as never,
    });
    const ctrl = new SemanticController(deps);
    const internal = ctrl as unknown as {
      reindexQueue: Set<string>;
      reindexTimer: number | null;
      flushReindex(): Promise<void>;
    };
    internal.reindexQueue.add(file.path);
    internal.reindexTimer = null;
    (ctrl as unknown as { indexer: () => { updateNotes: ReturnType<typeof vi.fn> } }).indexer = () => ({
      updateNotes: vi.fn().mockResolvedValue([{ path: file.path, error: new Error("Embedding failed") }]),
    });
    (ctrl as unknown as { canEmbedWithoutDownload: () => Promise<boolean> }).canEmbedWithoutDownload = async () => true;

    await internal.flushReindex();

    expect(failedActivities).toHaveLength(1);
    expect(failedActivities[0]?.id).toBe(`semantic-index:incremental:${file.path}`);
    expect(failedActivities[0]?.failed).toBe(1);
    expect(failedActivities[0]?.details).toEqual([
      expect.objectContaining({ label: file.path, state: "error" }),
    ]);
  });
});
