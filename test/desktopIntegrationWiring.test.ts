import { App, FileSystemAdapter, getLastOpenedModal, Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopIntegrationRuntime } from "../src/integrations/desktopCoordinator";
import { DesktopIntegrationsModal } from "../src/view/DesktopIntegrationsModal";
import type ClaudeCompanionPlugin from "../src/main";
import { buildPlugin } from "./fakes/plugin";

const readyRuntime = (): DesktopIntegrationRuntime => ({
  inspectClaudeCode: async () => ({
    claude: { available: true, version: "2.1.226" },
    obsidian: { available: true, version: "1.12.7" },
    marketplaceInstalled: true,
    pluginInstalled: true,
    pluginEnabled: true,
    bridge: { enabled: false, url: "", registered: false, headerValue: "" },
  }),
  setupClaudeCode: async () => ({
    claude: { available: true, version: "2.1.226" },
    obsidian: { available: true, version: "1.12.7" },
    marketplaceInstalled: true,
    pluginInstalled: true,
    pluginEnabled: true,
    bridge: { enabled: false, url: "", registered: false, headerValue: "" },
  }),
  installClaudeDesktop: async () => ({ configPath: "/config.json", backupPath: null, restartRequired: true }),
  openTerminalAtVault: async () => ({ opened: true }),
});

async function pluginHarness(runtime: DesktopIntegrationRuntime = readyRuntime()): Promise<ClaudeCompanionPlugin> {
  const app = new App();
  (app.vault as unknown as { adapter: FileSystemAdapter }).adapter = new FileSystemAdapter("/Vault Root");
  return buildPlugin({
    _desktopRuntimeLoader: vi.fn(async () => ({ createNodeDesktopRuntime: async () => runtime })),
    router: () => ({ anthropic: { hasCredentials: () => true } }),
    persist: async () => undefined,
    refreshViews: () => undefined,
    syncMcpServer: async () => undefined,
    mcpRunning: () => true,
  }, app);
}

afterEach(() => {
  Platform.isMobile = false;
  Platform.isDesktop = true;
});

describe("desktop integration plugin wiring", () => {
  it("lazily loads the desktop runtime and opens the focused modal", async () => {
    const plugin = await pluginHarness();
    plugin.desktopIntegrations().open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const loader = (plugin as unknown as { _desktopRuntimeLoader: ReturnType<typeof vi.fn> })._desktopRuntimeLoader;
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getLastOpenedModal()).toBeInstanceOf(DesktopIntegrationsModal);
  });

  it("never loads Node-backed runtime code on mobile", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const plugin = await pluginHarness();
    plugin.desktopIntegrations().open();
    await Promise.resolve();
    const loader = (plugin as unknown as { _desktopRuntimeLoader: ReturnType<typeof vi.fn> })._desktopRuntimeLoader;
    expect(loader).not.toHaveBeenCalled();
    expect(getLastOpenedModal()).toBeInstanceOf(DesktopIntegrationsModal);
  });

  it("closes active desktop integration work during plugin unload", async () => {
    const plugin = await pluginHarness();
    plugin.desktopIntegrations().open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const modal = getLastOpenedModal();
    expect(modal?.closed).toBe(false);
    plugin.onunload();
    expect(modal?.closed).toBe(true);
  });

  it("prepares Claude Desktop with a token-required read-only bridge", async () => {
    const plugin = await pluginHarness();
    plugin.settings.mcpAllowWrites = true;
    plugin.settings.mcpEnabled = false;
    plugin.settings.mcpToken = "existing-bridge-token";
    const result = await plugin.desktopIntegrations().configureClaudeDesktopBridge();
    expect(plugin.settings.mcpEnabled).toBe(true);
    expect(plugin.settings.mcpAllowWrites).toBe(false);
    expect(result).toEqual({ port: 22360, token: "existing-bridge-token" });
  });

  it("fails without exposing the bridge token when startup is unavailable", async () => {
    const plugin = await pluginHarness();
    plugin.settings.mcpToken = "private-bridge-token";
    Object.assign(plugin as unknown as Record<string, unknown>, { mcpRunning: () => false });
    await expect(plugin.desktopIntegrations().configureClaudeDesktopBridge()).rejects.not.toThrow("private-bridge-token");
  });
});
