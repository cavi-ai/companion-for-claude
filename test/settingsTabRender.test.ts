import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, openSettingTab, Platform, Setting, type ButtonComponent, type SettingDefinitionItem } from "./fakes/obsidian";
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
      claudeCli: { probe: () => null, hasCredentials: () => false, test: async () => ({ ok: false, detail: "" }), refresh: async () => ({ ok: false, detail: "" }) },
      codexCli: { probe: () => null, hasCredentials: () => false, test: async () => ({ ok: false, detail: "" }), refresh: async () => ({ ok: false, detail: "" }) },
      opencodeCli: { probe: () => null, hasCredentials: () => false, test: async () => ({ ok: false, detail: "" }), refresh: async () => ({ ok: false, detail: "" }) },
    }),
    secrets: () => unavailableStore(),
    secretsWriteFailures: () => [],
    externalMcp: () => ({ errorFor: () => null, test: async () => ({ ok: true }) }),
    mcpRunning: () => false,
    builtinModelCached: async () => true,
    builtinEmbedder: () => ({ backend: () => "wasm", download: async () => {} }),
    indexer: () => undefined,
    activity: { snapshot: () => ({ records: [{ kind: "semantic-index", title: "Building semantic index", state: "succeeded" }] }) },
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

function definitionsOf(plugin: ReturnType<typeof stubPlugin> = stubPlugin()): SettingDefinitionItem[] {
  const tab = new ClaudeCompanionSettingTab(new App() as never, plugin);
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

  it("edits the new-chat context defaults through nested codec keys", async () => {
    const plugin = stubPlugin();
    const tab = new ClaudeCompanionSettingTab(new App() as never, plugin);
    const context = plugin.settings.context as { activeNote: boolean; searchVault: boolean };

    expect(tab.getControlValue("context.activeNote")).toBe(context.activeNote);
    await tab.setControlValue("context.searchVault", true);
    expect(context.searchVault).toBe(true);
    await tab.setControlValue("context.activeNote", false);
    expect(context.activeNote).toBe(false);
    expect(tab.getControlValue("context.activeNote")).toBe(false);
  });

  it("declares the four new-chat context rows", () => {
    const plugin = stubPlugin();
    plugin.settings.settingsShowAdvanced = true;
    const keys = flatten(definitionsOf(plugin)).flatMap((item) => (item.control ? [item.control.key] : []));
    expect(keys).toEqual(expect.arrayContaining(["context.activeNote", "context.selection", "context.linkedNotes", "context.searchVault"]));
  });
});

describe("settings tab render", () => {
  it("renders every row, including the imperative ones", () => {
    const plugin = stubPlugin();
    plugin.settings.settingsShowAdvanced = true;
    const tab = new ClaudeCompanionSettingTab(new App() as never, plugin);
    expect(() => openSettingTab(tab)).not.toThrow();
    const container = tab.containerEl as unknown as FakeElement;

    const items = container.querySelectorAll(".setting-item");
    expect(items.length).toBeGreaterThan(50);

    const controls = container.querySelectorAll(".setting-item-control");
    expect(controls.filter((c) => c.children.length > 0).length).toBeGreaterThan(30);
    expect(container.querySelectorAll("button").some((b) => b.textContent === "Set up")).toBe(true);
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

describe("semantic settings action feedback", () => {
  it("reuses the index status instead of showing conflicting counts", () => {
    const plugin = stubPlugin();
    plugin.settings.semanticEnabled = true;
    const row = flatten(definitionsOf(plugin)).find((item) => item.name === "Rebuild index")!;
    const setting = new Setting(new FakeElement() as unknown as HTMLElement);
    setting.settingEl.createDiv({ cls: "cc-conn-status", text: "Index: 65 note(s), 694 chunk(s)." });

    row.render!(setting, undefined);

    expect(setting.settingEl.querySelectorAll(".cc-conn-status")).toHaveLength(1);
  });

  for (const engine of ["builtin", "ollama"] as const) {
    it(`shows a busy button and live status while ${engine} rebuilds`, async () => {
      const plugin = stubPlugin();
      plugin.settings.semanticEnabled = true;
      plugin.settings.embeddingEngine = engine;
      let finish!: () => void;
      plugin.rebuildSemanticIndex = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      plugin.indexer = () => ({ stats: async () => ({ notes: 2, chunks: 4 }) }) as never;
      const row = flatten(definitionsOf(plugin)).find((item) => item.name === "Rebuild index")!;
      const setting = new Setting(new FakeElement() as unknown as HTMLElement);
      row.render!(setting, undefined);
      const button = setting.components[0] as ButtonComponent;
      const status = setting.settingEl.querySelectorAll(".cc-semantic-index-status")[0]!;

      button.simulateClick();
      button.simulateClick();
      expect(plugin.rebuildSemanticIndex).toHaveBeenCalledTimes(1);
      expect(button.buttonEl.textContent).toBe("Rebuilding…");
      expect(button.buttonEl.getAttribute("aria-busy")).toBe("true");
      expect(button.buttonEl.disabled).toBe(true);
      expect(status.textContent).toBe("Rebuilding index…");

      finish();
      await vi.waitFor(() => expect(button.buttonEl.textContent).toBe("Rebuild"));
      expect(button.buttonEl.getAttribute("aria-busy")).toBe("false");
      expect(button.buttonEl.disabled).toBe(false);
      expect(status.textContent).toContain("2 note(s), 4 chunk(s)");
    });
  }

  it("shows a busy button while the built-in model loads and restores it afterward", async () => {
    const plugin = stubPlugin();
    plugin.settings.semanticEnabled = true;
    plugin.settings.embeddingEngine = "builtin";
    let finish!: () => void;
    let loaded = false;
    const download = vi.fn(() => new Promise<void>((resolve) => { finish = () => { loaded = true; resolve(); }; }));
    plugin.builtinModelCached = async () => false;
    plugin.builtinEmbedder = () => ({
      backend: () => loaded ? "wasm" : null,
      download,
    }) as never;
    const row = flatten(definitionsOf(plugin)).find((item) => item.name === "Embedding model")!;
    const setting = new Setting(new FakeElement() as unknown as HTMLElement);
    row.render!(setting, undefined);
    const button = setting.components[1] as ButtonComponent;
    const status = setting.settingEl.querySelectorAll(".cc-conn-status")[0]!;

    button.simulateClick();
    button.simulateClick();
    expect(download).toHaveBeenCalledTimes(1);
    expect(button.buttonEl.textContent).toBe("Downloading…");
    expect(button.buttonEl.getAttribute("aria-busy")).toBe("true");
    expect(button.buttonEl.disabled).toBe(true);
    expect(status.textContent).toContain("Downloading");

    finish();
    await vi.waitFor(() => expect(button.buttonEl.textContent).toBe("Re-check"));
    expect(button.buttonEl.getAttribute("aria-busy")).toBe("false");
    expect(button.buttonEl.disabled).toBe(false);
    expect(status.textContent).toContain("Model ready");
  });

  it("keeps model buttons responsive when clearing the built-in cache fails", async () => {
    const plugin = stubPlugin();
    plugin.settings.semanticEnabled = true;
    plugin.settings.embeddingEngine = "builtin";
    let fail!: (error: Error) => void;
    plugin.clearBuiltinModel = vi.fn(() => new Promise<number>((_resolve, reject) => { fail = reject; }));
    const row = flatten(definitionsOf(plugin)).find((item) => item.name === "Embedding model")!;
    const setting = new Setting(new FakeElement() as unknown as HTMLElement);
    row.render!(setting, undefined);
    const clear = setting.components[0] as ButtonComponent;
    const load = setting.components[1] as ButtonComponent;
    const status = setting.settingEl.querySelectorAll(".cc-conn-status")[0]!;

    clear.simulateClick();
    clear.simulateClick();
    expect(plugin.clearBuiltinModel).toHaveBeenCalledTimes(1);
    expect(clear.buttonEl.textContent).toBe("Clearing…");
    expect(clear.buttonEl.getAttribute("aria-busy")).toBe("true");
    expect(clear.buttonEl.disabled).toBe(true);
    expect(load.buttonEl.disabled).toBe(true);

    fail(new Error("cache locked"));
    await vi.waitFor(() => expect(status.textContent).toContain("Clear failed: cache locked"));
    expect(clear.buttonEl.textContent).toBe("Clear");
    expect(clear.buttonEl.disabled).toBe(false);
    expect(load.buttonEl.disabled).toBe(false);
  });

  it("reports a failed rebuild and enables retry", async () => {
    const plugin = stubPlugin();
    plugin.settings.semanticEnabled = true;
    plugin.settings.embeddingEngine = "ollama";
    plugin.rebuildSemanticIndex = async () => {};
    plugin.indexer = () => ({ stats: async () => ({ notes: 0, chunks: 0 }) }) as never;
    Object.assign(plugin, {
      activity: { snapshot: () => ({ records: [{ kind: "semantic-index", title: "Building semantic index", state: "needs-attention" }] }) },
    });
    const row = flatten(definitionsOf(plugin)).find((item) => item.name === "Rebuild index")!;
    const setting = new Setting(new FakeElement() as unknown as HTMLElement);
    row.render!(setting, undefined);
    const button = setting.components[0] as ButtonComponent;
    const status = setting.settingEl.querySelectorAll(".cc-semantic-index-status")[0]!;

    button.simulateClick();
    await vi.waitFor(() => expect(status.textContent).toContain("needs attention"));
    expect(button.buttonEl.disabled).toBe(false);
    expect(status.classList.has("is-err")).toBe(true);
  });
});

describe("Claude Code backend settings", () => {
  it("offers claude-cli in the chat backend dropdown, renders a status row, and warns that it covers chat only", () => {
    const defs = flatten(definitionsOf());
    const backend = defs.find((d) => (d.control as { key?: string } | undefined)?.key === "chatBackend") as { control: { options: Record<string, string> } } | undefined;
    expect(backend?.control.options["claude-cli"]).toBe("Claude Code — your subscription (desktop)");
    const status = defs.find((d) => d.name === "Claude Code") as { render?: unknown } | undefined;
    expect(typeof status?.render).toBe("function");
    const utility = defs.find((d) => (d.control as { key?: string } | undefined)?.key === "utilityBackend") as { desc?: string } | undefined;
    expect(utility?.desc).toContain("covers chat only");
  });

  it("hides the connect callout on the Claude Code backend when the CLI is signed in", () => {
    const plugin = stubPlugin();
    plugin.router = () => ({
      chatBackend: "claude-cli",
      anthropic: { hasCredentials: () => false },
      claudeCli: { hasCredentials: () => true },
      codexCli: { hasCredentials: () => false },
      opencodeCli: { hasCredentials: () => false },
    }) as never;
    const item = flatten(definitionsOf(plugin)).find((i) => i.name === "Step 1 — connect to Claude");
    expect(item?.visible?.()).toBe(false);
  });

  it("shows the connect callout on the Claude Code backend when the CLI is signed out", () => {
    const plugin = stubPlugin();
    plugin.router = () => ({
      chatBackend: "claude-cli",
      anthropic: { hasCredentials: () => false },
      claudeCli: { hasCredentials: () => false },
      codexCli: { hasCredentials: () => false },
      opencodeCli: { hasCredentials: () => false },
    }) as never;
    const item = flatten(definitionsOf(plugin)).find((i) => i.name === "Step 1 — connect to Claude");
    expect(item?.visible?.()).toBe(true);
  });

  it("renders Desktop integrations as a plain settings button", () => {
    const plugin = stubPlugin();
    const item = flatten(definitionsOf(plugin)).find((i) => i.name === "Desktop integrations");
    expect(item?.render).toBeTypeOf("function");
    const setting = new Setting(new FakeElement() as unknown as HTMLElement);
    item!.render!(setting, undefined);
    const button = (setting.settingEl as unknown as FakeElement).querySelectorAll("button")[0];
    expect(button?.textContent).toBe("Set up");
    expect(button?.classList?.has("cc-settings-desktop-integrations") ?? false).toBe(false);
  });
});
