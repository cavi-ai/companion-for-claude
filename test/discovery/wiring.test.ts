import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({
  requestUrl: vi.fn(async () => ({ status: 200, headers: {}, text: JSON.stringify({ results: [], meta: {} }) })),
}));
vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  requestUrl,
  FuzzySuggestModal: class {},
  PluginSettingTab: class {},
}));

import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { Provider } from "../../src/providers/types";
import { buildProjectSnapshot } from "../../src/research/graph";

const snapshot = buildProjectSnapshot("P.md", [{
  path: "P.md", title: "P", type: "research-project", project: "P.md", question: "What works?", audience: "Researchers", stage: "reason", status: "active",
}], []);

function provider(id: "anthropic" | "ollama", credentials = true): Provider {
  return {
    id, label: id, hasCredentials: () => credentials,
    stream: async () => undefined,
    complete: vi.fn(async () => JSON.stringify({ order: [] })),
    test: async () => ({ ok: true, detail: "ok" }),
  };
}

function pluginHarness(anthropic = provider("anthropic"), ollama = provider("ollama"), localAvailable = async () => true): ClaudeCompanionPlugin {
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS };
  Object.defineProperty(plugin, "router", { value: () => ({ anthropic, ollama, localAvailable }) });
  Object.defineProperty(plugin, "researchRepository", { value: () => ({ importSource: vi.fn() }) });
  return plugin;
}

describe("scholarly discovery plugin wiring", () => {
  beforeEach(() => { requestUrl.mockReset().mockResolvedValue({ status: 200, headers: {}, text: JSON.stringify({ results: [], meta: {} }) }); });

  it("owns one lazy coordinator with live adapter settings and no construction/state network work", async () => {
    const plugin = pluginHarness();
    expect(requestUrl).not.toHaveBeenCalled();
    const coordinator = plugin.discoveryCoordinator();
    expect(plugin.discoveryCoordinator()).toBe(coordinator);
    expect(coordinator.stateFor(snapshot).status).toBe("idle");
    expect(requestUrl).not.toHaveBeenCalled();

    plugin.settings.discoveryMaxResults = 999;
    plugin.settings.openAlexContactEmail = "  person@example.test  ";
    await coordinator.search(snapshot, "query");
    const url = new URL(requestUrl.mock.calls[0]![0].url);
    expect(url.searchParams.get("per-page")).toBe("100");
    expect(url.searchParams.get("mailto")).toBe("person@example.test");
  });

  it("creates isolated view coordinators and unload cancels all of them", () => {
    const plugin = pluginHarness();
    const first = plugin.createDiscoveryCoordinator(); const second = plugin.createDiscoveryCoordinator();
    expect(first).not.toBe(second);
    const firstCancel = vi.spyOn(first, "cancel"); const secondCancel = vi.spyOn(second, "cancel");
    first.cancel();
    expect(firstCancel).toHaveBeenCalledOnce(); expect(secondCancel).not.toHaveBeenCalled();
    plugin.onunload();
    expect(secondCancel).toHaveBeenCalledOnce();
  });

  it("clears every active view cache and releases closed-view coordinators", async () => {
    const plugin = pluginHarness();
    const first = plugin.createDiscoveryCoordinator(); const second = plugin.createDiscoveryCoordinator();
    await first.search(snapshot, "first"); await second.search(snapshot, "second");
    const firstClear = vi.spyOn(first, "clearCache"); const secondClear = vi.spyOn(second, "clearCache");
    plugin.clearDiscoveryCache();
    expect(firstClear).toHaveBeenCalledOnce(); expect(secondClear).toHaveBeenCalledOnce();
    expect(first.stateFor(snapshot).status).toBe("idle"); expect(second.stateFor(snapshot).status).toBe("idle");

    const firstCancel = vi.spyOn(first, "cancel");
    plugin.releaseDiscoveryCoordinator(first);
    plugin.releaseDiscoveryCoordinator(first);
    expect(firstCancel).toHaveBeenCalledOnce();
    plugin.onunload();
    expect(firstCancel).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous view searches independent when one view is cancelled", async () => {
    const pending: Array<{ resolve(): void }> = [];
    requestUrl.mockImplementation(() => new Promise((resolve) => pending.push({ resolve: () => resolve({ status: 200, headers: {}, text: JSON.stringify({ results: [], meta: {} }) }) })));
    const plugin = pluginHarness(); const first = plugin.createDiscoveryCoordinator(); const second = plugin.createDiscoveryCoordinator();
    const firstSearch = first.search(snapshot, "first"); const secondSearch = second.search(snapshot, "second");
    await Promise.resolve(); await Promise.resolve(); first.cancel();
    expect(pending).toHaveLength(2);
    pending.forEach(({ resolve }) => resolve());
    expect((await firstSearch).status).toBe("stale"); expect((await secondSearch).status).toBe("ready");
  });

  it("does no discovery work while loading settings or refreshing views", async () => {
    const plugin = pluginHarness();
    Object.defineProperty(plugin, "loadData", { value: async () => ({ settings: { discoveryMaxResults: 999 } }) });
    Object.defineProperty(plugin, "app", { value: { workspace: { getLeavesOfType: () => [] } } });
    await plugin.loadSettings();
    plugin.refreshViews();
    expect(plugin.settings.discoveryMaxResults).toBe(100);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("routes live strict/current modes and discloses the actual provider/model", async () => {
    const anthropic = provider("anthropic");
    const ollama = provider("ollama");
    const plugin = pluginHarness(anthropic, ollama);
    plugin.settings.model = "claude-sonnet-4-6";
    plugin.settings.ollamaModel = "local-model";

    const coordinator = plugin.discoveryCoordinator();
    await coordinator.search(snapshot, "q");
    plugin.settings.discoveryReranker = "claude";
    expect(await coordinator.rerank(snapshot)).toEqual(expect.objectContaining({ providerId: "anthropic", model: "claude-sonnet-4-6", usedFallback: false }));
    plugin.settings.discoveryReranker = "local";
    expect(await coordinator.rerank(snapshot)).toEqual(expect.objectContaining({ providerId: "ollama", model: "local-model", usedFallback: false }));
    plugin.settings.discoveryReranker = "current";
    plugin.settings.chatBackend = "local";
    await coordinator.rerank(snapshot);
    expect(ollama.complete).toHaveBeenCalled();
    plugin.settings.chatBackend = "claude";
    await coordinator.rerank(snapshot);
    expect(anthropic.complete).toHaveBeenCalled();
  });

  it("uses Current plus Auto credential fallback only when local is reachable", async () => {
    const anthropic = provider("anthropic", false);
    const ollama = provider("ollama", true);
    const plugin = pluginHarness(anthropic, ollama);
    const coordinator = plugin.discoveryCoordinator();
    await coordinator.search(snapshot, "q");
    plugin.settings.chatBackend = "auto";
    plugin.settings.discoveryReranker = "current";
    expect(await coordinator.rerank(snapshot)).toEqual(expect.objectContaining({ status: "ready", providerId: "ollama", usedFallback: true }));
    plugin.settings.discoveryReranker = "claude";
    expect((await coordinator.rerank(snapshot)).status).toBe("failed");

    const noLocalProvider = provider("ollama");
    const noLocal = pluginHarness(provider("anthropic", false), noLocalProvider, async () => false);
    noLocal.settings.discoveryReranker = "current";
    noLocal.settings.chatBackend = "auto";
    await noLocal.discoveryCoordinator().search(snapshot, "q");
    expect((await noLocal.discoveryCoordinator().rerank(snapshot)).status).toBe("failed");
    expect(noLocalProvider.complete).not.toHaveBeenCalled();
  });

  it("honors live discovery disablement with zero adapter/provider calls", async () => {
    const anthropic = provider("anthropic");
    const plugin = pluginHarness(anthropic);
    const coordinator = plugin.discoveryCoordinator();
    plugin.settings.discoveryEnabled = false;
    expect((await coordinator.search(snapshot, "q")).status).toBe("disabled");
    expect((await coordinator.expand(snapshot, "openalex:W1", "references")).status).toBe("disabled");
    expect((await coordinator.rerank(snapshot)).status).toBe("disabled");
    expect(requestUrl).not.toHaveBeenCalled();
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it("clears only existing derived coordinator state and unload cancels, clears, and releases it", () => {
    const plugin = pluginHarness();
    plugin.clearDiscoveryCache();
    const coordinator = plugin.discoveryCoordinator();
    const cancel = vi.spyOn(coordinator, "cancel");
    const clear = vi.spyOn(coordinator, "clearCache");
    plugin.clearDiscoveryCache();
    expect(clear).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();

    plugin.onunload();
    expect(cancel).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(plugin.discoveryCoordinator()).not.toBe(coordinator);
  });
});
