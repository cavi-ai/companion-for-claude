import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { DEFAULT_SETTINGS } from "../../src/types";
import type ClaudeCompanionPlugin from "../../src/main";
import { InboxView } from "../../src/view/InboxView";
import { MemoryView } from "../../src/view/MemoryView";
import { RelatedView } from "../../src/view/RelatedView";
import { ResearchDeskView } from "../../src/view/ResearchDeskView";
import { ResearchWorkbenchView } from "../../src/view/ResearchWorkbenchView";
import type { CompanionChromeDependencies } from "../../src/view/companionChrome";
import type { QuickOptionsState } from "../../src/view/quickOptions";

const state = (): QuickOptionsState => ({
  chatBackend: "auto", chatModel: "Claude Sonnet 5", agentModeEnabled: false, vaultContextEnabled: true,
  memoryIngestOnSave: false, utilityBackend: "claude", sourceEnrichOnCreate: true,
  sourceInboxFolder: "Clippings", sourceCaptureEnabled: false, clipperStatus: "not-set-up",
  semanticEnabled: true, embeddingEngine: "builtin", embeddingModel: "EmbeddingGemma",
  embeddingHealth: "Ready", indexHealth: "Ready", memoryEnabled: true, memoryFolder: "Memory",
  memoryAutoConsolidate: true, discoveryEnabled: true, discoveryReranker: "current",
});

const chrome = (app: App): CompanionChromeDependencies => ({
  app,
  activity: new ActivityStore(),
  snapshot: state,
  save: vi.fn(),
  run: vi.fn(),
  openAllSettings: vi.fn(),
});

const optionLabel = (root: HTMLElement): string | null => {
  const buttons = (root as unknown as FakeElement).querySelectorAll("button");
  return buttons.find((button) => button.getAttribute("aria-label")?.startsWith("Quick options for "))
    ?.getAttribute("aria-label") ?? null;
};

describe("Companion chrome view integration", () => {
  it("routes a quick embedding change through real saveSettings invalidation", async () => {
    const plugin = Object.create((await import("../../src/main")).default.prototype) as ClaudeCompanionPlugin;
    const invalidateIndexer = vi.fn();
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app: new App(),
      settings: structuredClone(DEFAULT_SETTINGS),
      persist: async () => undefined,
      refreshViews: () => undefined,
      syncMcpServer: async () => undefined,
      invalidateIndexer,
      indexerModel: "builtin:old-model",
      _mcpServersSnapshot: "[]",
    });

    await plugin.companionChrome().save({ id: "embedding-engine", value: "ollama" });

    expect(plugin.settings.embeddingEngine).toBe("ollama");
    expect(invalidateIndexer).toHaveBeenCalledTimes(1);
  });

  it("puts contextual options on Inbox, Related Notes, and Session Memory", async () => {
    const app = new App();
    (app.workspace as unknown as { getActiveFile(): null }).getActiveFile = () => null;
    const deps = chrome(app);
    const plugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      companionChrome: () => deps,
    } as unknown as ClaudeCompanionPlugin;
    plugin.settings.sourceCaptureEnabled = false;

    const inbox = new InboxView(new WorkspaceLeaf(app), plugin);
    const related = new RelatedView(new WorkspaceLeaf(app), plugin);
    const memory = new MemoryView(new WorkspaceLeaf(app), plugin);
    await inbox.render();
    await related.render();
    await memory.render();

    expect(optionLabel(inbox.contentEl)).toBe("Quick options for Source Inbox");
    expect(optionLabel(related.contentEl)).toBe("Quick options for Related Notes");
    expect(optionLabel(memory.contentEl)).toBe("Quick options for Session Memory");
  });

  it("puts contextual options on both research pages and refreshes their context", async () => {
    const app = new App();
    const deps = chrome(app);
    const desk = new ResearchDeskView(
      new WorkspaceLeaf(app),
      { listProjects: async () => [] } as never,
      { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn(), chrome: deps },
    );
    const workbench = new ResearchWorkbenchView(
      new WorkspaceLeaf(app),
      { loadProject: async () => { throw new Error("unused"); } } as never,
      {
        chrome: deps,
        narratorMode: () => "disabled",
        coordinator: {
          subscribe: () => () => undefined,
          stateFor: () => ({ status: "not-analyzed" }),
          analyze: async () => ({ status: "not-analyzed" }),
          cancel: vi.fn(),
        } as never,
      },
    );
    await desk.render();
    await workbench.render();

    expect(optionLabel(desk.contentEl)).toBe("Quick options for Research Desk");
    expect(optionLabel(workbench.contentEl)).toBe("Quick options for Research Workbench");
  });
});
