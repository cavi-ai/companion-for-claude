// Wires the runtime cluster: the build controller, the MCP bridge and the optimize feature.

import { Notice, Platform, TFile, normalizePath } from "obsidian";
import { BuildController, type BuildControllerDeps } from "../build/controller";
import type ClaudeCompanionPlugin from "../main";
import { McpBridgeController, type McpBridgeControllerDeps } from "../mcp/bridgeController";
import { catalogPromptProvider, composeResourceProviders, substrateResourceProvider, vaultResourceProvider } from "../mcp/providers";
import { VaultTools } from "../mcp/vaultTools";
import { OptimizeFeature } from "../optimize/feature";
import type { OptimizeState } from "../optimize/state";
import { UtilityUnavailableError } from "../providers/endpointPolicy";
import { ensureVaultFolder, writeOrReplaceFile } from "../vault/vaultFiles";
import { ConfirmModal } from "../view/ConfirmModal";
import { vaultToolOptions, type VaultToolsHost } from "./vaultTools";

export type BuildHost = Pick<ClaudeCompanionPlugin, "app" | "persist" | "publishing" | "settings" | "vaultBasePath">;

export interface BuildWiring {
  desktopRuntimeLoader: BuildControllerDeps["desktopRuntimeLoader"];
}

export function buildBuildController(host: BuildHost, wiring: BuildWiring): BuildController {
  return new BuildController({
    settings: () => host.settings,
    persist: () => host.persist(),
    isMobile: Platform.isMobile,
    vault: {
      cachedRead: (path) => {
        const file = host.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? host.app.vault.cachedRead(file) : Promise.reject(new Error(`File not found: ${path}`));
      },
      processFile: async (path, fn) => {
        const file = host.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await host.app.vault.process(file, fn);
      },
    },
    writeFile: async (path, content) => { await writeOrReplaceFile(host.app, path, content); },
    ensureFolder: (folder) => ensureVaultFolder(host.app, folder),
    openFile: async (path) => {
      const file = host.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await host.app.workspace.getLeaf(false).openFile(file);
    },
    normalizePath,
    notice: (msg, timeout) => new Notice(msg, timeout),
    confirm: (opts) => new Promise<boolean>((resolve) => {
      new ConfirmModal(host.app, { ...opts, onResolve: resolve }).open();
    }),
    cloud: () => host.publishing().cloud(),
    vaultBasePath: () => host.vaultBasePath(),
    desktopProcess: () => (window as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process,
    desktopRuntimeLoader: wiring.desktopRuntimeLoader,
  });
}

export type McpBridgeHost = VaultToolsHost & Pick<ClaudeCompanionPlugin, "app" | "manifest" | "memoryNotePath" | "promptTemplates" | "saveSettings" | "settings">;

export interface McpBridgeWiring {
  isLifecycleEnded: McpBridgeControllerDeps["isLifecycleEnded"];
  lifecycleGeneration: McpBridgeControllerDeps["lifecycleGeneration"];
}

export function buildMcpBridge(host: McpBridgeHost, wiring: McpBridgeWiring): McpBridgeController {
  return new McpBridgeController({
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    isMobile: Platform.isMobile,
    isLifecycleEnded: wiring.isLifecycleEnded,
    lifecycleGeneration: wiring.lifecycleGeneration,
    buildToolOptions: () => vaultToolOptions(host, host.settings.mcpAllowWrites),
    createTools: (opts) => new VaultTools(host.app, opts),
    createServer: async (tools, port, token) => {
      const { McpHttpServer } = await import("../mcp/server");
      return new McpHttpServer(
        {
          port,
          token,
          serverInfo: { name: "obsidian-vault", version: host.manifest.version },
          resources: composeResourceProviders(
            substrateResourceProvider(host.app, { call: (n, a) => (tools as unknown as VaultTools).call(n, a), memoryPath: () => host.memoryNotePath() }),
            vaultResourceProvider(host.app),
          ),
          prompts: catalogPromptProvider(() => host.promptTemplates()),
        },
        tools as unknown as VaultTools,
        (level, message) => { if (level === "error") console.error("[Claude Companion MCP]", message); },
      );
    },
    notice: (msg) => new Notice(msg),
  });
}

export type OptimizeHost = Pick<
  ClaudeCompanionPlugin,
  "activity" | "app" | "ontology" | "persist" | "router" | "semantic" | "settings" | "standingOrders" | "utilityRouting"
>;

export interface OptimizeWiring {
  state: { get(): OptimizeState; set(next: OptimizeState): void };
}

export function buildOptimize(host: OptimizeHost, wiring: OptimizeWiring): OptimizeFeature {
  return new OptimizeFeature({
    app: host.app,
    settings: () => host.settings,
    activity: () => host.activity,
    indexer: () => host.semantic().indexer(),
    ontology: () => host.ontology(),
    orderTagTriggers: () => host.standingOrders().tagTriggers(),
    router: () => host.router(),
    isMobile: Platform.isMobile,
    passiveUtilitySelection: () => {
      const selection = host.utilityRouting().runtimeSelection();
      if (selection.state === "configured-provider" || selection.state === "approved-Claude-fallback") return selection;
      throw new UtilityUnavailableError(host.utilityRouting().unavailableMessage(selection), selection);
    },
    assertActive: () => {
      if (host.utilityRouting().isEnded()) throw new Error("Companion unloaded while the model check was running; no further content was sent.");
    },
    getState: () => wiring.state.get(),
    setState: async (next) => {
      wiring.state.set(next);
      await host.persist();
    },
  });
}
