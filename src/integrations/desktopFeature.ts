// Desktop integrations: the setup modal, its Claude Code and Claude Desktop
// controller, and the read-only MCP bridge preparation behind it.

import { FileSystemAdapter, Notice, Platform, type App } from "obsidian";
import { sourceActivityDetail } from "../sources/controller";
import { bridgeHeaderValue, bridgeUrl, generateToken, resolveMcpToken } from "../mcp/clientConfig";
import type { ProviderRouter } from "../providers/router";
import type { PluginSettings } from "../types";
import { ChoiceModal } from "../view/ChoiceModal";
import { DesktopIntegrationsModal, type DesktopIntegrationsController } from "../view/DesktopIntegrationsModal";
import type { ManagedProcessPort } from "../build/desktopExecutor";
import { CLI_HOST_LABELS, type CliHost } from "./cliHosts";
import { claudeDesktopConfigPath, type DesktopPlatform } from "./desktop";
import { DesktopIntegrationCoordinator, type DesktopIntegrationRuntime } from "./desktopCoordinator";
import type { BridgeSetupInput } from "./desktopRuntime";

export interface DesktopFeatureDeps {
  app: App;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  router: () => ProviderRouter;
  resolvedMcpToken: () => string;
  mcpRunning: () => boolean;
  openCompanionSettings: () => void;
  openObsidianCliSettings: () => void;
  runtimeLoader: () => Promise<{
    createNodeDesktopRuntime(platform: DesktopPlatform, homeDir: string, env: Record<string, string | undefined>, bridge?: BridgeSetupInput): Promise<DesktopIntegrationRuntime>;
    createNodeManagedProcessPort(): ManagedProcessPort;
  }>;
}

export class DesktopFeature {
  private desktopIntegrationModals?: Set<DesktopIntegrationsModal>;

  constructor(private deps: DesktopFeatureDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Closes every open integrations modal. */
  dispose(): void {
    for (const modal of this.desktopIntegrationModals ?? []) modal.close();
    this.desktopIntegrationModals?.clear();
  }

  open(): void {
    if (Platform.isMobile) {
      this.openDesktopIntegrationsModal(this.mobileDesktopIntegrationsController());
      return;
    }
    void this.createDesktopIntegrationController()
      .then((controller) => this.openDesktopIntegrationsModal(controller))
      .catch((cause: unknown) => {
        new Notice(`Desktop integrations could not open: ${sourceActivityDetail(cause instanceof Error ? cause.message : String(cause))}`);
      });
  }

  async configureClaudeDesktopBridge(): Promise<{ port: number; token: string }> {
    this.settings.mcpAllowWrites = false;
    this.settings.mcpEnabled = true;
    if (!this.deps.resolvedMcpToken()) this.settings.mcpToken = generateToken();
    await this.deps.saveSettings();
    if (!this.deps.mcpRunning()) throw new Error(`The read-only MCP bridge could not start on port ${this.settings.mcpPort}.`);
    const token = this.deps.resolvedMcpToken();
    if (!token) throw new Error("The MCP bridge did not produce an access token.");
    return { port: this.settings.mcpPort, token };
  }

  /** enabled=false, never a partial bridge: no working step without a resolvable token. */
  private claudeCodeBridgeInput(env: Record<string, string | undefined>): BridgeSetupInput {
    const resolved = resolveMcpToken(env, this.settings.mcpToken);
    if (!this.settings.mcpEnabled || !resolved.token) return { enabled: false, url: "", headerValue: "" };
    return { enabled: true, url: bridgeUrl(this.settings.mcpPort), headerValue: bridgeHeaderValue(resolved) };
  }

  /**
   * Keep Claude Desktop's extension and the agent CLIs' connector pointed at
   * this vault's bridge after a port or token change. Only a connection file a
   * Connect action wrote for this vault is touched.
   */
  async refreshConnection(port: number, token: string): Promise<void> {
    if (Platform.isMobile) return;
    const { adapter, platform, env, homeDir } = this.desktopEnvironment();
    if (platform !== "darwin" && platform !== "win32") return;
    const module = await this.deps.runtimeLoader();
    const runtime = await module.createNodeDesktopRuntime(platform, homeDir, { APPDATA: env.APPDATA });
    await runtime.refreshConnection?.({ port, token, vault: { name: this.app.vault.getName(), path: adapter.getBasePath() } });
  }

  private desktopEnvironment(): { adapter: FileSystemAdapter; platform: DesktopPlatform; env: Record<string, string | undefined>; homeDir: string } {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("This vault does not expose a desktop filesystem path.");
    const processLike = (window as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
    const platform: DesktopPlatform = processLike?.platform === "darwin" || processLike?.platform === "win32" || processLike?.platform === "linux"
      ? processLike.platform
      : "unsupported";
    const env = processLike?.env ?? {};
    const homeDir = env.HOME || env.USERPROFILE || "";
    if (!homeDir) throw new Error("The desktop home directory is unavailable.");
    return { adapter, platform, env, homeDir };
  }

  private async createDesktopIntegrationController(): Promise<DesktopIntegrationCoordinator> {
    const { adapter, platform, env, homeDir } = this.desktopEnvironment();
    const module = await this.deps.runtimeLoader();
    const runtime = await module.createNodeDesktopRuntime(platform, homeDir, { APPDATA: env.APPDATA }, this.claudeCodeBridgeInput(env));
    return new DesktopIntegrationCoordinator({
      runtime,
      providerReady: () => this.deps.router().anthropic.hasCredentials() || this.settings.chatBackend !== "claude",
      vaultPath: adapter.getBasePath(),
      vaultName: this.app.vault.getName(),
      prepareClaudeDesktopBridge: () => this.configureClaudeDesktopBridge(),
      copy: async (text) => {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
        await navigator.clipboard.writeText(text);
      },
    });
  }

  private openDesktopIntegrationsModal(controller: DesktopIntegrationsController): void {
    const processLike = (window as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
    const env = processLike?.env ?? {};
    const platform = processLike?.platform === "darwin" || processLike?.platform === "win32" || processLike?.platform === "linux"
      ? processLike.platform
      : "unsupported";
    let configPath: string | undefined;
    if (!Platform.isMobile) {
      try {
        configPath = claudeDesktopConfigPath(platform, env.HOME || env.USERPROFILE || "", { APPDATA: env.APPDATA });
      } catch (e) {
        console.debug("Claude Companion: could not resolve Desktop config path", e);
        configPath = undefined;
      }
    }
    const modal = new DesktopIntegrationsModal(this.app, {
      controller,
      mobile: Platform.isMobile,
      platform,
      openConnectionSettings: () => this.deps.openCompanionSettings(),
      openBridgeSettings: () => this.deps.openCompanionSettings(),
      openObsidianCliSettings: () => this.deps.openObsidianCliSettings(),
      confirm: (target, message) => this.confirmDesktopIntegration(target, message),
      ...(configPath ? { claudeDesktopConfigPath: configPath } : {}),
      closed: () => this.desktopIntegrationModals?.delete(modal),
    });
    (this.desktopIntegrationModals ??= new Set()).add(modal);
    modal.open();
  }

  private mobileDesktopIntegrationsController(): DesktopIntegrationsController {
    const state = { status: "idle" as const, providerReady: this.deps.router().anthropic.hasCredentials() || this.settings.chatBackend !== "claude" };
    return {
      snapshot: () => state,
      subscribe: () => () => undefined,
      refresh: async () => undefined,
      setupClaudeCode: async () => undefined,
      connectClaudeDesktop: async () => undefined,
      connectCliHost: async () => undefined,
      openTerminal: async () => undefined,
      dispose: () => undefined,
    };
  }

  private confirmDesktopIntegration(target: "claude-code" | "claude-desktop" | CliHost, message: string): Promise<boolean> {
    const title = target === "claude-code"
      ? "Set up Claude Code?"
      : target === "claude-desktop" ? "Connect Claude Desktop?" : `Connect ${CLI_HOST_LABELS[target]}?`;
    return new Promise((resolve) => {
      new ChoiceModal(this.app, {
        title,
        message,
        buttons: [
          { label: "Cancel", value: "cancel" as const },
          { label: target === "claude-code" ? "Set up" : "Connect read-only", value: "confirm" as const, cta: true },
        ],
        fallback: "cancel" as const,
        onChoice: (choice) => resolve(choice === "confirm"),
      }).open();
    });
  }
}
