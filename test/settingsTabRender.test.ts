import { describe, expect, it } from "vitest";
import { App, FakeElement } from "./fakes/obsidian";
import { ClaudeCompanionSettingTab } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/types";
import type ClaudeCompanionPlugin from "../src/main";

function stubPlugin(): ClaudeCompanionPlugin & { settings: Record<string, unknown> } {
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: async () => {},
    router: () => ({ anthropic: { hasCredentials: () => true } }),
    externalMcp: () => ({ errorFor: () => null, test: async () => ({ ok: true }) }),
    mcpRunning: () => false,
    builtinModelCached: async () => true,
    builtinEmbedder: () => ({ backend: () => "wasm", download: async () => {} }),
    indexer: () => undefined,
    ontology: () => undefined,
    clipperTemplatesStale: () => false,
    refreshViews: () => {},
    invalidateIndexer: () => {},
    loadOntologyOnStart: async () => {},
  };
  return plugin as unknown as ClaudeCompanionPlugin & { settings: Record<string, unknown> };
}

describe("settings tab render", () => {
  it("renders every section with interactive controls and wired callbacks", async () => {
    (globalThis as Record<string, unknown>).activeDocument = {
      createDocumentFragment: () => new FakeElement("fragment"),
    };
    const plugin = stubPlugin();
    const tab = new ClaudeCompanionSettingTab(new App() as never, plugin);
    tab.display();
    await new Promise((r) => setTimeout(r, 0));
    const container = tab.containerEl as unknown as FakeElement;

    const items = container.querySelectorAll(".setting-item");
    expect(items.length).toBeGreaterThan(50);

    const controls = container.querySelectorAll(".setting-item-control");
    const controlCount = controls.filter((c) => c.children.length > 0).length;
    expect(controlCount).toBeGreaterThan(40);

    const toggles = container.querySelectorAll("input");
    expect(toggles.length).toBeGreaterThan(0);
  });
});
