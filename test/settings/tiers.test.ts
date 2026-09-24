import { describe, expect, it } from "vitest";
import { App, type SettingDefinitionItem } from "../fakes/obsidian";
import { ClaudeCompanionSettingTab } from "../../src/settings";
import { DEFAULT_SETTINGS } from "../../src/types";
import { unavailableStore } from "../../src/secrets/store";
import type ClaudeCompanionPlugin from "../../src/main";

type Tiered = SettingDefinitionItem & { tier?: "basic" | "advanced" };

function stubPlugin(showAdvanced = false, overrides: Record<string, unknown> = {}): ClaudeCompanionPlugin & { settings: Record<string, unknown> } {
  const plugin = {
    settings: { ...structuredClone(DEFAULT_SETTINGS), settingsShowAdvanced: showAdvanced, ...overrides },
    saveSettings: async () => {},
    router: () => ({
      anthropic: { hasCredentials: () => true, test: async () => ({ ok: true, detail: "" }) },
      ollama: { listModels: async () => [], capabilities: async () => [], test: async () => ({ ok: true, detail: "" }) },
      openaiCompat: { listModels: async () => [], test: async () => ({ ok: true, detail: "" }) },
      claudeCli: { probe: () => null, hasCredentials: () => false, test: async () => ({ ok: false, detail: "" }), refresh: async () => ({ ok: false, detail: "" }) },
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

function definitionsOf(showAdvanced = false, overrides: Record<string, unknown> = {}): Tiered[] {
  const tab = new ClaudeCompanionSettingTab(new App() as never, stubPlugin(showAdvanced, overrides));
  return tab.getSettingDefinitions() as unknown as Tiered[];
}

function isContainerOrPage(item: Tiered): boolean {
  return item.type === "group" || item.type === "list" || item.type === "page";
}

/** Every leaf definition (not group/list/page), flattened. */
function leaves(items: Tiered[]): Tiered[] {
  return items.flatMap((item) => (isContainerOrPage(item) ? leaves(item.items ?? []) : [item]));
}

function evalVisible(item: Tiered): boolean {
  return typeof item.visible === "function" ? item.visible() : (item.visible ?? true);
}

describe("settings tiers", () => {
  it("gives every leaf item a tier", () => {
    const rows = leaves(definitionsOf());
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) expect(row.tier, row.name).toBeDefined();
  });

  it("keeps the basic count at or under 30", () => {
    const basic = leaves(definitionsOf()).filter((row) => row.tier === "basic");
    expect(basic.length).toBeGreaterThan(0);
    expect(basic.length).toBeLessThanOrEqual(30);
  });

  it("shows only the basic items on a mixed page with the toggle off", () => {
    const page = definitionsOf().flatMap((g) => g.items ?? []).find((p) => p.name === "Agent (act on your vault)");
    expect(page).toBeTruthy();
    const rows = leaves(page!.items as Tiered[]);
    const basicNames = rows.filter((r) => r.tier === "basic").map((r) => r.name).sort();
    const visibleNames = rows.filter((r) => evalVisible(r)).map((r) => r.name).sort();
    expect(visibleNames).toEqual(basicNames);
  });

  it("hides a page with zero basic items until the toggle is on, and shows it once on", () => {
    const off = definitionsOf(false).flatMap((g) => g.items ?? []).find((p) => p.name === "Agent bridge — MCP server (desktop)");
    const on = definitionsOf(true).flatMap((g) => g.items ?? []).find((p) => p.name === "Agent bridge — MCP server (desktop)");
    expect(off).toBeTruthy();
    expect(evalVisible(off!)).toBe(false);
    expect(evalVisible(on!)).toBe(true);
  });

  it("keeps a basic page visible regardless of the toggle", () => {
    const off = definitionsOf(false).flatMap((g) => g.items ?? []).find((p) => p.name === "Semantic search (local embeddings)");
    expect(evalVisible(off!)).toBe(true);
  });

  it("shows the Local models page with the toggle off when chat is routed to a local backend", () => {
    const local = definitionsOf(false, { chatBackend: "local" }).flatMap((g) => g.items ?? []).find((p) => p.name === "Local models (Ollama & endpoints)");
    expect(evalVisible(local!)).toBe(true);
  });

  it("hides the Local models page with the toggle off on default settings", () => {
    const defaults = definitionsOf(false).flatMap((g) => g.items ?? []).find((p) => p.name === "Local models (Ollama & endpoints)");
    expect(evalVisible(defaults!)).toBe(false);
  });
});
