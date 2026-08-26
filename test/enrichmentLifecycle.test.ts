import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  PluginSettingTab: class {},
}));

import { App, FakeElement, getLastOpenedModal, TFile, WorkspaceLeaf } from "obsidian";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import { InboxView, INBOX_VIEW_TYPE } from "../src/view/InboxView";
import { ChoiceModal } from "../src/view/ChoiceModal";

type EnrichRunOutcome = Awaited<ReturnType<ClaudeCompanionPlugin["enrichInboxItem"]>>;

interface EnrichmentLifecyclePlugin {
  queueEnrich(file: TFile): void;
  markEnrichRecentlyWritten(path: string): void;
  enrichTimers: Map<string, number>;
  enrichPending: Map<string, TFile>;
  enrichQueueRunning: boolean;
  enrichRecentlyWritten: Set<string>;
  enrichRecentlyWrittenExpiryTimers: Map<string, number>;
}

const settle = async (turns = 12): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

function inboxPlugin(
  app: App,
  enrichInboxItem: (file: TFile, options?: { inline?: boolean }) => Promise<EnrichRunOutcome>,
): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin, {
    app,
    settings: { ...DEFAULT_SETTINGS, sourceCaptureEnabled: true, sourceInboxFolder: "Clippings" },
    enrichInboxItem,
    sourceEnrichmentBackendLabel: () => "Ollama · utility-model",
  });
  return plugin;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

afterEach(() => vi.useRealTimers());

describe("enrichment lifecycle", () => {
  it("single-flights the same clip across automatic and Inbox enrichment", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/same.md", "Same clip");
    const release = deferred<void>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin, {
      app,
      settings: {
        ...DEFAULT_SETTINGS,
        sourceCaptureConsent: "allow",
        sourceCaptureEnabled: true,
        sourceEnrichOnCreate: true,
        sourceInboxFolder: "Clippings",
      },
      utilityLifecycleEnded: false,
      utilityLifecycleGeneration: 0,
      enrichTimers: new Map<string, number>(),
      enrichPending: new Map<string, TFile>(),
      enrichQueueRunning: false,
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      runEnrich: async (candidate: TFile): Promise<EnrichRunOutcome> => {
        started.push(candidate.path);
        active++;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active--;
        return { status: "enriched" };
      },
    });
    const lifecycle = plugin as unknown as EnrichmentLifecyclePlugin;

    lifecycle.queueEnrich(file);
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    const inbox = plugin.enrichInboxItem(file, { inline: true, refreshInboxViews: false });
    await settle();

    expect(started).toEqual([file.path]);
    expect(maxActive).toBe(1);

    release.resolve();
    await expect(inbox).resolves.toEqual({ status: "enriched" });
    await settle();
    expect(lifecycle.enrichQueueRunning).toBe(false);
  });

  it("serializes different clips across automatic and Inbox enrichment", async () => {
    vi.useFakeTimers();
    const app = new App();
    const automatic = app.vault.seed("Clippings/automatic.md", "Automatic clip");
    const inbox = app.vault.seed("Clippings/inbox.md", "Inbox clip");
    const releaseAutomatic = deferred<void>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin, {
      app,
      settings: {
        ...DEFAULT_SETTINGS,
        sourceCaptureConsent: "allow",
        sourceCaptureEnabled: true,
        sourceEnrichOnCreate: true,
        sourceInboxFolder: "Clippings",
      },
      utilityLifecycleEnded: false,
      utilityLifecycleGeneration: 0,
      enrichTimers: new Map<string, number>(),
      enrichPending: new Map<string, TFile>(),
      enrichQueueRunning: false,
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      runEnrich: async (candidate: TFile): Promise<EnrichRunOutcome> => {
        started.push(candidate.path);
        active++;
        maxActive = Math.max(maxActive, active);
        if (candidate.path === automatic.path) await releaseAutomatic.promise;
        active--;
        return { status: "enriched" };
      },
    });
    const lifecycle = plugin as unknown as EnrichmentLifecyclePlugin;

    lifecycle.queueEnrich(automatic);
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    const inboxResult = plugin.enrichInboxItem(inbox, { inline: true, refreshInboxViews: false });
    await settle();

    expect(started).toEqual([automatic.path]);
    expect(maxActive).toBe(1);

    releaseAutomatic.resolve();
    await expect(inboxResult).resolves.toEqual({ status: "enriched" });
    expect(started).toEqual([automatic.path, inbox.path]);
    expect(maxActive).toBe(1);
  });

  it("serializes a burst of automatic Clipper enrichments and continues after one fails", async () => {
    vi.useFakeTimers();
    const first = new TFile("Clippings/first.md", "First", 0);
    const second = new TFile("Clippings/second.md", "Second", 0);
    const third = new TFile("Clippings/third.md", "Third", 0);
    const releaseFirst = deferred<void>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin, {
      utilityLifecycleEnded: false,
      utilityLifecycleGeneration: 0,
      enrichTimers: new Map<string, number>(),
      enrichPending: new Map<string, TFile>(),
      enrichQueueRunning: false,
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      enrichFile: async (file: TFile): Promise<EnrichRunOutcome> => {
        started.push(file.path);
        active++;
        maxActive = Math.max(maxActive, active);
        if (file.path === first.path || file.path === second.path) await releaseFirst.promise;
        active--;
        if (file.path === second.path) throw new Error("malformed clipping");
        return { status: "enriched" };
      },
    });
    const lifecycle = plugin as unknown as EnrichmentLifecyclePlugin;

    lifecycle.queueEnrich(first);
    lifecycle.queueEnrich(second);
    lifecycle.queueEnrich(third);
    await vi.advanceTimersByTimeAsync(1500);
    await settle();

    expect(started).toEqual([first.path]);
    expect(maxActive).toBe(1);

    releaseFirst.resolve();
    await settle(24);
    expect(started).toEqual([first.path, second.path, third.path]);
    expect(maxActive).toBe(1);
    expect(lifecycle.enrichPending.size).toBe(0);
    expect(lifecycle.enrichQueueRunning).toBe(false);
    expect(plugin.activity.snapshot().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "needs-attention", details: [expect.objectContaining({ message: "malformed clipping" })] }),
    ]));
  });

  it("surfaces a consent persistence failure and lets the automatic queue continue", async () => {
    vi.useFakeTimers();
    const app = new App();
    const first = app.vault.seed("Clippings/first.md", "First clip");
    const second = app.vault.seed("Clippings/second.md", "Second clip");
    const saveSettings = vi.fn()
      .mockRejectedValueOnce(new Error("settings disk full"))
      .mockResolvedValue(undefined);
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin, {
      app,
      settings: { ...DEFAULT_SETTINGS, sourceCaptureConsent: "ask", sourceCaptureEnabled: true, sourceEnrichOnCreate: true, sourceInboxFolder: "Clippings" },
      utilityLifecycleEnded: false,
      utilityLifecycleGeneration: 0,
      enrichTimers: new Map<string, number>(),
      enrichPending: new Map<string, TFile>(),
      enrichQueueRunning: false,
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      saveSettings,
    });
    const lifecycle = plugin as unknown as EnrichmentLifecyclePlugin;

    lifecycle.queueEnrich(first);
    await vi.advanceTimersByTimeAsync(1500);
    const allow = (getLastOpenedModal()?.contentEl as unknown as FakeElement).querySelectorAll("button").find(({ textContent }) => textContent === "Enrich automatically");
    allow?.dispatchEvent({ type: "click" });
    await settle(24);

    expect(lifecycle.enrichQueueRunning).toBe(false);
    expect(plugin.activity.snapshot().records[0]).toMatchObject({ state: "needs-attention", details: [expect.objectContaining({ message: "settings disk full" })] });

    lifecycle.queueEnrich(second);
    await vi.advanceTimersByTimeAsync(1500);
    const deny = (getLastOpenedModal()?.contentEl as unknown as FakeElement).querySelectorAll("button").find(({ textContent }) => textContent === "Manual only");
    deny?.dispatchEvent({ type: "click" });
    await settle(24);
    expect(lifecycle.enrichQueueRunning).toBe(false);
    expect(lifecycle.enrichPending.size).toBe(0);
  });

  it("treats persisted manual-only consent as an immediate skip without reopening consent", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/manual.md", "Manual clip");
    const opened = vi.spyOn(ChoiceModal.prototype, "open");
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin, {
      app,
      settings: { ...DEFAULT_SETTINGS, sourceCaptureConsent: "deny", sourceCaptureEnabled: true, sourceEnrichOnCreate: true, sourceInboxFolder: "Clippings" },
      utilityLifecycleEnded: false,
      utilityLifecycleGeneration: 0,
      enrichTimers: new Map<string, number>(),
      enrichPending: new Map<string, TFile>(),
      enrichQueueRunning: false,
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
    });
    const lifecycle = plugin as unknown as EnrichmentLifecyclePlugin;

    lifecycle.queueEnrich(file);
    await vi.advanceTimersByTimeAsync(1500);
    await settle();

    expect(opened).not.toHaveBeenCalled();
    expect(lifecycle.enrichQueueRunning).toBe(false);
  });

  it("publishes honest per-file batch percentage and retains partial failures", async () => {
    const app = new App();
    app.vault.seed("Clippings/first.md", "First clip");
    app.vault.seed("Clippings/second.md", "Second clip");
    const first = deferred<EnrichRunOutcome>();
    const second = deferred<EnrichRunOutcome>();
    let call = 0;
    const plugin = inboxPlugin(app, async () => (++call === 1 ? first.promise : second.promise));
    const view = new InboxView(new WorkspaceLeaf(app), plugin);
    await view.render();

    (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all")?.dispatchEvent({ type: "click" });
    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      id: "source-enrichment:inbox-batch", completed: 0, total: 2, percent: 0, state: "running",
    });

    first.resolve({ status: "enriched" });
    await settle();
    expect(plugin.activity.snapshot().records[0]).toMatchObject({ completed: 1, total: 2, percent: 50, succeeded: 1, failed: 0 });

    second.resolve({ status: "failed", error: new Error("Ollama refused connection") });
    await settle(24);
    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      completed: 2, total: 2, percent: 100, succeeded: 1, failed: 1, state: "needs-attention",
    });
    expect(plugin.activity.snapshot().records[0]?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Clippings/first.md", state: "success" }),
      expect.objectContaining({ label: "Clippings/second.md", message: "Ollama refused connection", state: "error" }),
    ]));
  });

  it("catches a regression that rescans the full Inbox for every item in enrich-all", async () => {
    vi.useFakeTimers();
    const app = new App();
    const pendingCount = 4;
    const enrichedCount = 4;
    for (let index = 0; index < pendingCount; index++) {
      app.vault.seed(`Clippings/pending-${index}.md`, `Private clip ${index}.`);
    }
    for (let index = 0; index < enrichedCount; index++) {
      app.vault.seed(`Clippings/enriched-${index}.md`, "No unlinked mentions.", {
        frontmatter: { source_enriched: true },
      });
    }

    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin, {
      app,
      settings: {
        ...DEFAULT_SETTINGS,
        sourceCaptureEnabled: true,
        sourceCaptureConsent: "allow",
        sourceInboxFolder: "Clippings",
        utilityBackend: "custom",
        openaiCompatHost: "https://models.example.com/v1",
        openaiCompatModel: "remote-model",
      },
      enrichTimers: new Map<string, number>(),
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
    });
    vi.spyOn(plugin.router().openaiCompat, "complete").mockImplementation(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
      return JSON.stringify({
        title: "Useful private capture",
        site: "Vault",
        summary: "A concise private capture summary.",
      });
    });
    const view = new InboxView(new WorkspaceLeaf(app), plugin);
    app.workspace = {
      getLeaf: () => ({ openFile: async () => undefined }),
      getLeavesOfType: (type: string) => type === INBOX_VIEW_TYPE ? [{ view }] : [],
    } as never;

    const vault = app.vault as unknown as {
      cachedRead(file: TFile): Promise<string>;
      process(file: TFile, transform: (current: string) => string): Promise<string>;
    };
    const cachedRead = vault.cachedRead.bind(vault);
    const processFile = vault.process.bind(vault);
    const metadataCache = app.metadataCache as unknown as { trigger(name: string, file: TFile): void };
    let reads = 0;
    vault.cachedRead = async (file) => {
      reads++;
      return cachedRead(file);
    };
    vault.process = async (file, transform) => {
      const next = await processFile(file, transform);
      metadataCache.trigger("changed", file);
      return next;
    };

    await view.onOpen();
    await settle(32);
    reads = 0;
    (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all")?.dispatchEvent({ type: "click" });
    await vi.advanceTimersByTimeAsync(1000);
    await settle(160);

    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all")?.disabled).toBe(false);
    expect(reads).toBeLessThanOrEqual((pendingCount * 2) + (enrichedCount * 2));
    plugin.onunload();
  });

  it("catches a regression that leaves queued enrichment or expiry work alive after unload", () => {
    vi.useFakeTimers();
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    const file = new TFile("Clippings/later.md", "Later", 0);
    Object.assign(plugin, {
      utilityLifecycleEnded: false,
      utilityLifecycleGeneration: 0,
      enrichTimers: new Map<string, number>(),
      enrichPending: new Map([["Clippings/pending.md", new TFile("Clippings/pending.md", "Pending", 0)]]),
      enrichQueueRunning: false,
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      reindexTimer: null,
      _ontologyReloadTimer: null,
      researchRefreshTimer: null,
      inboxBadgeTimer: null,
    });
    const lifecycle = plugin as unknown as EnrichmentLifecyclePlugin;

    lifecycle.queueEnrich(file);
    lifecycle.markEnrichRecentlyWritten(file.path);
    expect(vi.getTimerCount()).toBe(2);

    plugin.onunload();
    lifecycle.markEnrichRecentlyWritten("Clippings/stale.md");
    vi.runAllTimers();

    expect(lifecycle.enrichTimers.size).toBe(0);
    expect(lifecycle.enrichPending.size).toBe(0);
    expect(lifecycle.enrichRecentlyWrittenExpiryTimers.size).toBe(0);
    expect(lifecycle.enrichRecentlyWritten.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches a regression that reports an Inbox enrichment failure only through a Notice", async () => {
    const app = new App();
    app.vault.seed("Clippings/failed.md", "Private clip");
    const plugin = inboxPlugin(app, async () => ({ status: "failed", error: new Error("remote model unavailable") }));
    const view = new InboxView(new WorkspaceLeaf(app), plugin);

    await view.render();
    const button = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich");
    button?.dispatchEvent({ type: "click" });
    await settle();

    const status = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrichment-status");
    expect(status?.textContent).toContain("remote model unavailable");
    expect(status?.classList.has("cc-inbox-enrichment-error")).toBe(true);
  });

  it("catches a regression that leaves an Inbox batch locked after one file fails", async () => {
    const app = new App();
    app.vault.seed("Clippings/failed.md", "Private clip");
    app.vault.seed("Clippings/next.md", "Another clip");
    let calls = 0;
    const plugin = inboxPlugin(app, async () => {
      if (++calls === 1) return { status: "failed", error: new Error("remote model unavailable") };
      return { status: "enriched" };
    });
    const view = new InboxView(new WorkspaceLeaf(app), plugin);

    await view.render();
    const button = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all");
    button?.dispatchEvent({ type: "click" });
    await settle(32);

    const retry = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all");
    expect(retry?.disabled).toBe(false);
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrichment-status")?.textContent)
      .toContain("remote model unavailable");
  });

  it("catches a regression that leaves a single-note control locked when its first render rejects", async () => {
    const app = new App();
    app.vault.seed("Clippings/single.md", "Private clip");
    const plugin = inboxPlugin(app, async () => ({ status: "enriched" }));
    const view = new InboxView(new WorkspaceLeaf(app), plugin);
    await view.render();
    vi.spyOn(view, "render").mockRejectedValueOnce(new Error("paint failed"));

    (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich")?.dispatchEvent({ type: "click" });
    await settle();

    const retry = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich");
    expect(retry?.disabled).toBe(false);
    retry?.dispatchEvent({ type: "click" });
    await settle();
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-operation-status")?.classList.has("cc-inbox-operation-success")).toBe(true);
  });

  it("catches a regression that leaves an enrich-all control locked when its first render rejects", async () => {
    const app = new App();
    app.vault.seed("Clippings/batch.md", "Private clip");
    const plugin = inboxPlugin(app, async () => ({ status: "enriched" }));
    const view = new InboxView(new WorkspaceLeaf(app), plugin);
    await view.render();
    vi.spyOn(view, "render").mockRejectedValueOnce(new Error("paint failed"));

    (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all")?.dispatchEvent({ type: "click" });
    await settle();

    const retry = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich-all");
    expect(retry?.disabled).toBe(false);
    retry?.dispatchEvent({ type: "click" });
    await settle();
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-operation-status")?.classList.has("cc-inbox-operation-success")).toBe(true);
  });

  it("catches a regression that leaves a link-review control locked when its first render rejects", async () => {
    const app = new App();
    app.vault.seed("Clippings/linked.md", "Project Atlas", { frontmatter: { source_enriched: true } });
    app.vault.seed("Notes/Project Atlas.md", "");
    const plugin = inboxPlugin(app, async () => ({ status: "enriched" }));
    Object.assign(plugin, {
      linkCandidates: () => [{ path: "Notes/Project Atlas.md", basename: "Project Atlas", aliases: [] }],
      reviewInboxLinkSuggestions: async () => ({ appliedFiles: 0, appliedHunks: 0, conflicts: [], failures: [] }),
    });
    const view = new InboxView(new WorkspaceLeaf(app), plugin);
    await view.render();
    await settle();
    vi.spyOn(view, "render").mockRejectedValueOnce(new Error("paint failed"));

    (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-review-all")?.dispatchEvent({ type: "click" });
    await settle();

    const retry = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-review-all");
    expect(retry?.disabled).toBe(false);
    retry?.dispatchEvent({ type: "click" });
    await settle();
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-operation-status")?.classList.has("cc-inbox-operation-success")).toBe(true);
  });

  it("catches a regression that leaves a completed control disabled when its final render rejects", async () => {
    const app = new App();
    app.vault.seed("Clippings/final-render.md", "Private clip");
    const plugin = inboxPlugin(app, async () => ({ status: "enriched" }));
    const view = new InboxView(new WorkspaceLeaf(app), plugin);
    await view.render();
    const render = view.render.bind(view);
    vi.spyOn(view, "render")
      .mockImplementationOnce(render)
      .mockRejectedValueOnce(new Error("final paint failed"));

    (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich")?.dispatchEvent({ type: "click" });
    await settle();

    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-enrich")?.disabled).toBe(false);
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-operation-status")?.classList.has("cc-inbox-operation-success")).toBe(true);
  });
});
