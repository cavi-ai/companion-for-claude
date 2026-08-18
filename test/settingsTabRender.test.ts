import { describe, expect, it } from "vitest";
import { App, FakeElement, openSettingTab, Platform, type SettingDefinitionItem } from "./fakes/obsidian";
import { ClaudeCompanionSettingTab } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/types";
import { unavailableStore } from "../src/secrets/store";
import type ClaudeCompanionPlugin from "../src/main";

function stubPlugin(): ClaudeCompanionPlugin & { settings: Record<string, unknown> } {
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: async () => {},
    router: () => ({
      anthropic: { hasCredentials: () => true, test: async () => ({ ok: true, detail: "" }) },
      ollama: { listModels: async () => [], capabilities: async () => [], test: async () => ({ ok: true, detail: "" }) },
      openaiCompat: { listModels: async () => [], test: async () => ({ ok: true, detail: "" }) },
    }),
    secrets: () => unavailableStore(),
    secretsWriteFailures: () => [],
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
    openDesktopIntegrations: () => {},
  };
  return plugin as unknown as ClaudeCompanionPlugin & { settings: Record<string, unknown> };
}

/** Every definition in the tree, groups and pages flattened away. */
function flatten(items: SettingDefinitionItem[]): SettingDefinitionItem[] {
  return items.flatMap((item) => (item.items ? [item, ...flatten(item.items)] : [item]));
}

function definitionsOf(): SettingDefinitionItem[] {
  const tab = new ClaudeCompanionSettingTab(new App() as never, stubPlugin());
  return tab.getSettingDefinitions() as unknown as SettingDefinitionItem[];
}

describe("settings definitions", () => {
  it("declares a name on every searchable row", () => {
    const rows = flatten(definitionsOf()).filter((item) => item.type !== "group");
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) expect(row.name, JSON.stringify(row)).toBeTruthy();
  });

  it("binds every control to a real settings key", () => {
    const controls = flatten(definitionsOf()).flatMap((item) => (item.control ? [item.control] : []));
    expect(controls.length).toBeGreaterThan(30);
    for (const control of controls) {
      expect(DEFAULT_SETTINGS, `unknown settings key: ${control.key}`).toHaveProperty(control.key);
    }
    // A dropdown with no options would render an empty, unusable control.
    for (const control of controls.filter((c) => c.type === "dropdown")) {
      expect(Object.keys(control.options ?? {}).length, control.key).toBeGreaterThan(0);
    }
  });

  it("gates every desktop-only page behind a visibility predicate", () => {
    const pages = flatten(definitionsOf()).filter((item) => item.type === "page");
    const desktopOnly = ["Agent bridge — MCP server (desktop)", "Local models (Ollama & endpoints)", "Session memory"];
    for (const name of desktopOnly) {
      const page = pages.find((p) => p.name === name);
      expect(page, `missing page: ${name}`).toBeDefined();
      expect(typeof page?.visible, name).toBe("function");
    }
  });

  it("round-trips a control through get/setControlValue, including the codec keys", async () => {
    const plugin = stubPlugin();
    const tab = new ClaudeCompanionSettingTab(new App() as never, plugin);

    await tab.setControlValue("agentAllowWrites", true);
    expect(tab.getControlValue("agentAllowWrites")).toBe(true);

    // Folder fields fall back to their default when emptied.
    await tab.setControlValue("chatFolder", "   ");
    expect(plugin.settings.chatFolder).toBe("Claude/Chats");

    // Tag fields are comma-separated in the control and string[] in settings.
    await tab.setControlValue("artifactBaseTags", "one, two ,, three");
    expect(plugin.settings.artifactBaseTags).toEqual(["one", "two", "three"]);
    expect(tab.getControlValue("artifactBaseTags")).toBe("one, two, three");

    // Discovery numbers are clamped by normalizeDiscoverySettings.
    await tab.setControlValue("discoveryMaxResults", 9999);
    expect(plugin.settings.discoveryMaxResults).toBe(100);
  });
});

describe("settings tab render", () => {
  it("renders every row, including the imperative ones", () => {
    const tab = new ClaudeCompanionSettingTab(new App() as never, stubPlugin());
    expect(() => openSettingTab(tab)).not.toThrow();
    const container = tab.containerEl as unknown as FakeElement;

    const items = container.querySelectorAll(".setting-item");
    expect(items.length).toBeGreaterThan(50);

    const controls = container.querySelectorAll(".setting-item-control");
    expect(controls.filter((c) => c.children.length > 0).length).toBeGreaterThan(30);
    expect(container.querySelectorAll("button").some((b) => b.textContent === "Desktop integrations")).toBe(true);
  });

  it("renders on mobile with the desktop-only pages withheld", () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    try {
      const tab = new ClaudeCompanionSettingTab(new App() as never, stubPlugin());
      expect(() => openSettingTab(tab)).not.toThrow();
      const names = (tab.containerEl as unknown as FakeElement)
        .querySelectorAll(".setting-item-name")
        .map((el) => el.textContent);
      expect(names).not.toContain("Enable MCP server");
      expect(names).not.toContain("Ollama host");
      expect(names).toContain("Let Claude use vault tools");
    } finally {
      Platform.isMobile = false;
      Platform.isDesktop = true;
    }
  });
});
