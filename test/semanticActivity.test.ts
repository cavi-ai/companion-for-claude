import { App, clearNotices, FakeElement, getNotices, WorkspaceLeaf } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import type { BuildResult } from "../src/semantic/indexer";
import { RelatedView } from "../src/view/RelatedView";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe("semantic activity", () => {
  beforeEach(() => clearNotices());

  it("moves determinate index progress and partial failures out of blocking Notices", async () => {
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    const completion = deferred<BuildResult>();
    const build = vi.fn(async ({ onProgress }: { onProgress(done: number, total: number): void }) => {
      onProgress(2, 4);
      return completion.promise;
    });
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app: new App(),
      settings: { ...structuredClone(DEFAULT_SETTINGS), semanticEnabled: true, embeddingEngine: "ollama" },
      router: () => ({ ollama: { hasCredentials: () => true } }),
      indexer: () => ({ build }),
    });

    const running = plugin.rebuildSemanticIndex();
    await Promise.resolve();
    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      completed: 2, total: 4, percent: 50, state: "running",
    });
    expect(getNotices().filter(({ timeout }) => timeout === 0)).toHaveLength(0);

    completion.resolve({
      indexed: 3,
      skipped: 1,
      removed: 0,
      failureCount: 1,
      failures: [{ path: "Research/broken.md", message: "Ollama refused connection" }],
    });
    await running;

    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      completed: 4, total: 4, percent: 100, state: "needs-attention", succeeded: 3, failed: 1,
    });
    expect(plugin.activity.snapshot().records[0]?.details).toEqual([
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
});
