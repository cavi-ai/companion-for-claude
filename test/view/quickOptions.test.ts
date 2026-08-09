import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
  QuickOptionsModal,
  type QuickOptionsModalDependencies,
} from "../../src/view/QuickOptionsModal";
import {
  quickOptionsFor,
  type CompanionPage,
  type QuickOptionsState,
} from "../../src/view/quickOptions";

const state = (overrides: Partial<QuickOptionsState> = {}): QuickOptionsState => ({
  chatBackend: "auto",
  chatModel: "Claude Sonnet 5",
  agentModeEnabled: false,
  vaultContextEnabled: true,
  memoryIngestOnSave: false,
  utilityBackend: "ollama",
  utilityEndpoint: "http://studio.local:11434",
  sourceEnrichOnCreate: true,
  sourceInboxFolder: "Clippings",
  sourceCaptureEnabled: true,
  clipperStatus: "current",
  semanticEnabled: true,
  embeddingEngine: "builtin",
  embeddingModel: "EmbeddingGemma",
  embeddingHealth: "Ready",
  indexHealth: "Built today",
  memoryEnabled: true,
  memoryFolder: "Claude/Memory",
  memoryAutoConsolidate: true,
  activeProject: "Field study",
  discoveryEnabled: true,
  activeResearchTab: "Overview",
  discoveryReranker: "current",
  ...overrides,
});

describe("quickOptionsFor", () => {
  it("keeps Source Inbox options contextual and orders all settings last", () => {
    expect(quickOptionsFor("inbox", state()).map((item) => item.id)).toEqual([
      "utility-backend",
      "auto-enrich",
      "inbox-folder",
      "source-capture",
      "clipper-schemas",
      "embedding-health",
      "all-settings",
    ]);
  });

  it("defines a focused menu for every Companion page", () => {
    const pages: CompanionPage[] = ["chat", "inbox", "related", "memory", "research-desk", "research-workbench"];
    for (const page of pages) {
      const options = quickOptionsFor(page, state());
      expect(options.length).toBeGreaterThan(1);
      expect(options.at(-1)?.id).toBe("all-settings");
      expect(new Set(options.map(({ id }) => id)).size).toBe(options.length);
    }
  });

  it("uses the active Workbench context rather than a stale generic value", () => {
    expect(quickOptionsFor("research-workbench", state({ activeResearchTab: "Discover" })))
      .toContainEqual(expect.objectContaining({ id: "research-section", value: "Discover" }));
  });
});

describe("QuickOptionsModal", () => {
  it("reads a fresh settings snapshot each time it opens", () => {
    let current = state({ sourceInboxFolder: "First" });
    const deps: QuickOptionsModalDependencies = {
      snapshot: vi.fn(() => current),
      save: vi.fn(),
      run: vi.fn(),
      openAllSettings: vi.fn(),
    };
    const first = new QuickOptionsModal(new App(), "inbox", deps);
    first.onOpen();
    expect((first.contentEl as unknown as FakeElement).querySelectorAll("input")
      .find((input) => input.getAttribute("aria-label") === "Inbox folder")?.value).toBe("First");

    current = state({ sourceInboxFolder: "Changed elsewhere" });
    const second = new QuickOptionsModal(new App(), "inbox", deps);
    second.onOpen();
    expect((second.contentEl as unknown as FakeElement).querySelectorAll("input")
      .find((input) => input.getAttribute("aria-label") === "Inbox folder")?.value).toBe("Changed elsewhere");
    expect(deps.snapshot).toHaveBeenCalledTimes(2);
  });

  it("writes toggles through the shared save boundary and keeps all settings last", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const openAllSettings = vi.fn();
    const modal = new QuickOptionsModal(new App(), "inbox", {
      snapshot: () => state(),
      save,
      run: vi.fn(),
      openAllSettings,
    });
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    const toggles = root.querySelectorAll("input").filter((input) => input.type === "checkbox");
    toggles[0]!.checked = false;
    toggles[0]!.dispatchEvent({ type: "change" });
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith({ id: "auto-enrich", value: false });

    const buttons = root.querySelectorAll("button");
    expect(buttons.at(-1)?.textContent).toBe("Open all settings");
    buttons.at(-1)?.dispatchEvent({ type: "click" });
    expect(openAllSettings).toHaveBeenCalledTimes(1);
  });
});
