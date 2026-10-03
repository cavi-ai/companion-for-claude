import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, Setting, type ButtonComponent, type SettingDefinitionItem, type TextComponent } from "../fakes/obsidian";
import { ClaudeCompanionSettingTab } from "../../src/settings";
import { DEFAULT_SETTINGS } from "../../src/types";
import { hydrate, stripVerifiedSecrets, syncSecrets, type SecretStore } from "../../src/secrets/store";
import { unavailableStore } from "../../src/secrets/store";
import type { PublishedItem } from "../../src/publish/registry";
import type ClaudeCompanionPlugin from "../../src/main";

type Row = SettingDefinitionItem & { tier?: string; render?: (setting: Setting) => void };

const ITEM: PublishedItem = { key: "n/A.md", kind: "note", title: "A", gistId: "g1", url: "https://gist.github.com/me/g1", owner: "me", publishedAt: 1, updatedAt: 1 };

function stubPlugin(items: PublishedItem[] = []) {
  const ok = { ok: true, detail: "" };
  const cli = { probe: () => null, hasCredentials: () => false, test: async () => ({ ok: false, detail: "" }), refresh: async () => ({ ok: false, detail: "" }) };
  const plugin = {
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: vi.fn(async () => {}),
    router: () => ({
      chatProvider: () => ({ provider: { id: "anthropic", label: "Claude (Anthropic API)" }, model: "claude-test" }),
      providerLabel: () => "Claude API",
      anthropic: { hasCredentials: () => true, test: async () => ok },
      ollama: { listModels: async () => [], capabilities: async () => [], test: async () => ok },
      openaiCompat: { listModels: async () => [], test: async () => ok },
      claudeCli: cli,
      codexCli: cli,
      opencodeCli: cli,
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
    publishedItems: () => items,
    unpublishItem: vi.fn(async () => {}),
    testPublishToken: vi.fn(async () => ({ ok: true, message: "GitHub accepted the token." })),
  };
  return plugin;
}

function publishingPage(plugin: ReturnType<typeof stubPlugin>, showAdvanced = false): { page: Row; rows: Row[] } {
  plugin.settings.settingsShowAdvanced = showAdvanced;
  const tab = new ClaudeCompanionSettingTab(new App() as never, plugin as unknown as ClaudeCompanionPlugin);
  const groups = tab.getSettingDefinitions() as unknown as Row[];
  const page = groups.flatMap((g) => (g.items ?? []) as Row[]).find((p) => p.name === "Publishing");
  if (!page) throw new Error("no Publishing page");
  return { page, rows: (page.items ?? []) as Row[] };
}

function renderRow(rows: Row[], name: string): { setting: Setting; container: FakeElement } {
  const row = rows.find((r) => r.name === name);
  if (!row?.render) throw new Error(`no render row ${name}`);
  const container = new FakeElement();
  const setting = new Setting(container);
  row.render(setting);
  return { setting, container };
}

const visible = (item: Row): boolean => (typeof item.visible === "function" ? item.visible() : (item.visible ?? true));

describe("Publishing settings page", () => {
  it("is a basic page: visible, with its rows shown, while advanced settings are off", () => {
    const { page, rows } = publishingPage(stubPlugin(), false);
    expect(visible(page)).toBe(true);
    expect(rows.map((r) => r.name)).toEqual(["GitHub Gist token", "Test Gist token", "Published items"]);
    for (const row of rows) {
      expect(row.tier, row.name).toBe("basic");
      expect(visible(row), row.name).toBe(true);
    }
  });

  it("saves the trimmed token through settings", async () => {
    const plugin = stubPlugin();
    const { setting } = renderRow(publishingPage(plugin).rows, "GitHub Gist token");
    const text = setting.components[0] as TextComponent;
    expect((text.inputEl as unknown as { type?: string }).type).toBe("password");
    text.simulateInput("  ghp_abc ");
    await Promise.resolve();
    expect(plugin.settings.publishGithubToken).toBe("ghp_abc");
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("shows the token test result", async () => {
    const plugin = stubPlugin();
    const { setting, container } = renderRow(publishingPage(plugin).rows, "Test Gist token");
    (setting.components[0] as ButtonComponent).simulateClick();
    await vi.waitFor(() => expect(container.querySelector(".cc-conn-status")?.textContent).toBe("✓ GitHub accepted the token."));
    expect(plugin.testPublishToken).toHaveBeenCalledTimes(1);
  });

  it("lists published items with a link and an Unpublish button", async () => {
    const plugin = stubPlugin([ITEM]);
    const { container } = renderRow(publishingPage(plugin).rows, "Published items");
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("A");
    expect(link?.getAttribute("href")).toBe(ITEM.url);
    const unpublish = container.querySelectorAll("button").find((b) => b.textContent === "Unpublish");
    unpublish!.dispatchEvent({ type: "click" });
    expect(plugin.unpublishItem).toHaveBeenCalledWith("n/A.md");
  });

  it("says so when nothing is published", () => {
    const { container } = renderRow(publishingPage(stubPlugin()).rows, "Published items");
    expect(container.querySelector(".cc-publish-empty")?.textContent).toBe("Nothing published yet.");
  });
});

describe("publish token storage", () => {
  const memoryStore = (): SecretStore & { values: Map<string, string> } => {
    const values = new Map<string, string>();
    return { values, available: () => true, get: (id) => values.get(id) ?? null, set: (id, v) => { values.set(id, v); return true; } };
  };

  it("starts empty", () => {
    expect(DEFAULT_SETTINGS.publishGithubToken).toBe("");
    expect(DEFAULT_SETTINGS.publishApiBase).toBe("");
  });

  it("lives in the secret store and is blanked from the persisted copy", () => {
    const store = memoryStore();
    const settings = { ...structuredClone(DEFAULT_SETTINGS), publishGithubToken: "ghp_SENTINEL" };
    syncSecrets(settings, store);
    expect([...store.values.values()]).toContain("ghp_SENTINEL");
    const { settings: persisted, unverified } = stripVerifiedSecrets(settings, store);
    expect(unverified).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain("ghp_SENTINEL");
    expect(hydrate(persisted, store).publishGithubToken).toBe("ghp_SENTINEL");
  });
});
