import { App, FileSystemAdapter, Platform, clearNotices, getLastOpenedModal, getNoticeMessages } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFeature, type DesktopFeatureDeps } from "../../src/integrations/desktopFeature";
import type { DesktopIntegrationRuntime } from "../../src/integrations/desktopCoordinator";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { DesktopIntegrationsModal } from "../../src/view/DesktopIntegrationsModal";

const status = {
  claude: { available: true, version: "2.1.226" },
  obsidian: { available: true, version: "1.12.7" },
  marketplaceInstalled: true,
  pluginInstalled: true,
  pluginEnabled: true,
  bridge: { enabled: false, url: "", registered: false, headerValue: "" },
};
const runtime: DesktopIntegrationRuntime = {
  inspectClaudeCode: async () => status,
  setupClaudeCode: async () => status,
  installClaudeDesktop: async () => ({ configPath: "/config.json", backupPath: null, restartRequired: true }),
  openTerminalAtVault: async () => ({ opened: true }),
};

function rig(over: { settings?: Partial<PluginSettings>; running?: boolean; token?: string; vaultAdapter?: boolean } = {}) {
  const app = new App();
  if (over.vaultAdapter !== false) (app.vault as unknown as { adapter: FileSystemAdapter }).adapter = new FileSystemAdapter("/Vault Root");
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...over.settings };
  const runtimeLoader = vi.fn(async () => ({ createNodeDesktopRuntime: async () => runtime })) as unknown as DesktopFeatureDeps["runtimeLoader"];
  const saveSettings = vi.fn(async () => undefined);
  const openCompanionSettings = vi.fn();
  const openObsidianCliSettings = vi.fn();
  let token = over.token ?? "";
  const deps: DesktopFeatureDeps = {
    app,
    settings: () => settings,
    saveSettings: async () => { await saveSettings(); if (settings.mcpToken) token = settings.mcpToken; },
    router: () => ({ anthropic: { hasCredentials: () => true } }) as never,
    resolvedMcpToken: () => token,
    mcpRunning: () => over.running ?? true,
    openCompanionSettings,
    openObsidianCliSettings,
    runtimeLoader,
  };
  return { feature: new DesktopFeature(deps), settings, runtimeLoader, saveSettings, openCompanionSettings };
}

beforeEach(() => { clearNotices(); });
afterEach(() => {
  Platform.isMobile = false;
  Platform.isDesktop = true;
  vi.unstubAllEnvs();
});

describe("DesktopFeature open", () => {
  it("loads the desktop runtime lazily and opens the integrations modal", async () => {
    const { feature, runtimeLoader } = rig();
    const before = getLastOpenedModal();
    expect(runtimeLoader).not.toHaveBeenCalled();
    feature.open();
    await vi.waitFor(() => expect(getLastOpenedModal()).not.toBe(before));
    expect(getLastOpenedModal()).toBeInstanceOf(DesktopIntegrationsModal);
    expect(runtimeLoader).toHaveBeenCalledTimes(1);
  });

  it("never loads Node-backed runtime code on mobile", () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const { feature, runtimeLoader } = rig();
    const before = getLastOpenedModal();
    feature.open();
    expect(runtimeLoader).not.toHaveBeenCalled();
    expect(getLastOpenedModal()).not.toBe(before);
    expect(getLastOpenedModal()).toBeInstanceOf(DesktopIntegrationsModal);
  });

  it("explains why the modal could not open when the runtime fails to load", async () => {
    const { feature, runtimeLoader } = rig();
    (runtimeLoader as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("cannot load"));
    feature.open();
    await vi.waitFor(() => expect(getNoticeMessages()).toHaveLength(1));
    expect(getNoticeMessages()[0]).toMatch(/^Desktop integrations could not open: .*cannot load/);
  });

  it("explains a vault without a desktop path", async () => {
    const { feature } = rig({ vaultAdapter: false });
    feature.open();
    await vi.waitFor(() => expect(getNoticeMessages()).toHaveLength(1));
    expect(getNoticeMessages()[0]).toContain("This vault does not expose a desktop filesystem path.");
  });

  it("explains a missing home directory", async () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    const { feature } = rig();
    feature.open();
    await vi.waitFor(() => expect(getNoticeMessages()).toHaveLength(1));
    expect(getNoticeMessages()[0]).toContain("The desktop home directory is unavailable.");
  });

  it("closes every open modal on dispose", async () => {
    const { feature } = rig();
    const before = getLastOpenedModal();
    feature.open();
    await vi.waitFor(() => expect(getLastOpenedModal()).not.toBe(before));
    const modal = getLastOpenedModal();
    expect(modal?.closed).toBe(false);
    feature.dispose();
    expect(modal?.closed).toBe(true);
  });
});

describe("DesktopFeature bridge", () => {
  it("turns the bridge on read-only and keeps an existing token", async () => {
    const { feature, settings, saveSettings } = rig({ settings: { mcpAllowWrites: true, mcpEnabled: false, mcpToken: "existing-bridge-token" }, token: "existing-bridge-token" });
    const result = await feature.configureClaudeDesktopBridge();
    expect(settings.mcpEnabled).toBe(true);
    expect(settings.mcpAllowWrites).toBe(false);
    expect(settings.mcpToken).toBe("existing-bridge-token");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ port: settings.mcpPort, token: "existing-bridge-token" });
  });

  it("generates a token when none resolves", async () => {
    const { feature, settings } = rig({ settings: { mcpToken: "" } });
    const result = await feature.configureClaudeDesktopBridge();
    expect(settings.mcpToken.length).toBeGreaterThan(0);
    expect(result.token).toBe(settings.mcpToken);
  });

  it("fails without exposing the token when the bridge did not start", async () => {
    const { feature } = rig({ settings: { mcpToken: "private-bridge-token" }, token: "private-bridge-token", running: false });
    const failure = await feature.configureClaudeDesktopBridge().catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("could not start on port");
    expect((failure as Error).message).not.toContain("private-bridge-token");
  });

  it("fails when the running bridge produced no token", async () => {
    const { feature } = rig({ settings: { mcpToken: "" }, running: true });
    const deps = (feature as unknown as { deps: DesktopFeatureDeps }).deps;
    deps.resolvedMcpToken = () => "";
    await expect(feature.configureClaudeDesktopBridge()).rejects.toThrow("The MCP bridge did not produce an access token.");
  });
});
