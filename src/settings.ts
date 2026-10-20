import { chatBackendForRuntime } from "./providers/runtimeBackend";
import { App, Platform, PluginSettingTab, type Plugin, type SettingDefinitionItem } from "obsidian";
import type ClaudeCompanionPlugin from "./main";
import type { ProviderStatus } from "./providers/types";
import { offerIndexRebuild } from "./view/rebuildOffer";
import { CODECS } from "./settingsItems/codecs";
import { PAGE_DESC } from "./settingsItems/pageDesc";
import { agentItems, type AgentItemsContext } from "./settingsItems/agent";
import { cloudDesc, cloudItems, repliesItems, type CloudItemsContext } from "./settingsItems/cloud";
import { connectionItems, type ConnectionItemsContext } from "./settingsItems/connection";
import { discoveryItems, type DiscoveryItemsContext } from "./settingsItems/discovery";
import { behaviorItems, desktopOnlyItems, indexingItems, memoryItems, ontologyItems, privacyItems, storageItems } from "./settingsItems/files";
import { introItems, type IntroItemsContext } from "./settingsItems/intro";
import { localModelsItems, type DetectedModels, type LocalModelsItemsContext } from "./settingsItems/localModels";
import { mcpItems, type McpBridgeItemsContext } from "./settingsItems/mcpBridge";
import { mcpClientItems, type McpClientItemsContext } from "./settingsItems/mcpClient";
import { publishItems } from "./settingsItems/publish";
import { semanticItems, type SemanticItemsContext } from "./settingsItems/semantic";
import { sourceCaptureItems, type SourceCaptureItemsContext } from "./settingsItems/sourceCapture";
import { SettingsNavigation } from "./view/SettingsNavigation";

export type { SettingsTier } from "./settingsItems/tiers";

/** The plugin capabilities the settings tab and its page builders use; Obsidian's base class needs the Plugin itself. */
export type SettingsHost = Plugin
  & AgentItemsContext["plugin"] & CloudItemsContext["plugin"] & ConnectionItemsContext["plugin"] & DiscoveryItemsContext["plugin"]
  & IntroItemsContext["plugin"] & LocalModelsItemsContext["plugin"] & McpBridgeItemsContext["plugin"] & McpClientItemsContext["plugin"]
  & SemanticItemsContext["plugin"] & SourceCaptureItemsContext["plugin"]
  & Pick<ClaudeCompanionPlugin, "onboarding" | "ontology" | "refreshViews" | "router" | "secrets" | "secretsWriteFailures" | "settings">;

export class ClaudeCompanionSettingTab extends PluginSettingTab {
  /** Models from the last Detect (Ollama; the OpenAI-compatible endpoint such as LM Studio, mlx-lm, vLLM, Jan), for the dropdowns. */
  private detectedModels: DetectedModels = { ollama: null, endpoint: null };
  /** Transient (not persisted): reveal the real MCP token in the snippets. */
  private tokenReveal = { shown: false };
  private navigation = new SettingsNavigation({
    update: () => this.update(),
    container: () => this.containerEl,
    openSetup: () => this.plugin.onboarding().openSetupWizard(),
    openDesktop: () => this.plugin.desktopIntegrations().open(),
  });

  constructor(
    app: App,
    private plugin: SettingsHost,
  ) {
    super(app, plugin);
  }

  /** Where credentials actually land, so the copy can't claim safety it doesn't have. */
  private storageBlurb(): string {
    return this.secretStorageWorking()
      ? "Stored in your device's secret storage, not in this vault."
      : "Stored locally in this vault's plugin data.";
  }

  /** The API being present is not proof the backend took the write. */
  private secretStorageWorking(): boolean {
    return this.plugin.secrets().available() && this.plugin.secretsWriteFailures().length === 0;
  }

  override getControlValue(key: string): unknown {
    const codec = CODECS[key];
    const s = this.plugin.settings;
    if (key === "chatBackend") return chatBackendForRuntime(s.chatBackend, Platform.isMobile);
    return codec ? codec.read(s) : (s as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    const codec = CODECS[key];
    if (codec) codec.write(s, value);
    else (s as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
    await this.afterChange(key);
  }

  /** Per-key follow-up the old onChange handlers did after saving. */
  private async afterChange(key: string): Promise<void> {
    switch (key) {
      case "model":
      case "customModel":
      case "chatBackend":
      case "researchModel":
      case "openaiCompatModel":
        if (key === "chatBackend") {
          const backend = this.plugin.settings.chatBackend;
          const cli = backend === "claude-cli" ? this.plugin.router().claudeCli : backend === "codex-cli" ? this.plugin.router().codexCli : backend === "opencode-cli" ? this.plugin.router().opencodeCli : null;
          if (cli) void cli.refresh().then(() => this.plugin.refreshViews());
        }
        this.plugin.refreshViews();
        return;
      case "semanticIndexPdfs":
        this.plugin.semantic().invalidateIndexer();
        return;
      case "openaiCompatEmbeddingModel":
        this.plugin.semantic().invalidateIndexer();
        return;
      case "ontologyFolder":
        await this.plugin.ontology()?.load();
        return;
      case "ontologyEnabled":
        // Turning it on here is an explicit ask, so the seed offer follows
        // regardless of credential — the gate is a startup ordering rule.
        if (this.plugin.settings.ontologyEnabled) {
          await this.plugin.onboarding().loadOntologyOnStart();
          void this.plugin.onboarding().offerOntologySeed();
        }
        return;
      case "sourceEnrichOnCreate":
        // Re-enabling is explicit consent to send inbox files to the utility model.
        if (this.plugin.settings.sourceEnrichOnCreate) {
          this.plugin.settings.sourceCaptureConsent = "allow";
          await this.plugin.saveSettings();
        }
        return;
      // Rows below gate the visibility of other rows, or feed a checklist.
      case "authMode":
      case "semanticEnabled":
      case "webSearchEnabled":
      case "webSearchEngine":
      case "cloudDispatchEnabled":
      case "cloudRoutineFireUrl":
      case "cloudRoutineToken":
      case "cloudReplyRepo":
      case "cloudReplyBranch":
      case "cloudReplyFolder":
      case "cloudReplyToken":
        this.update();
        return;
      default:
        return;
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return this.navigation.definitions(this.getSettingsCatalog(), this.plugin.settings);
  }

  /** One canonical catalog supplies the everyday view, advanced view and search. */
  getSettingsCatalog(): SettingDefinitionItem[] {
    return this.rawSettingDefinitions();
  }

  private rawSettingDefinitions(): SettingDefinitionItem[] {
    const plugin = this.plugin;
    const update = (): void => this.update();
    const storageBlurb = (): string => this.storageBlurb();
    const renderStatus = (el: HTMLElement, status: ProviderStatus): void => this.renderStatus(el, status);
    const cloud: CloudItemsContext = { plugin, update, storageBlurb };
    return [
      { type: "group", items: introItems({ plugin, secretStorageWorking: () => this.secretStorageWorking(), storageBlurb }) },
      { type: "group", heading: "Connection", items: connectionItems({ plugin, storageBlurb, renderStatus }) },
      { type: "group", heading: "Behavior", items: behaviorItems() },
      {
        type: "group",
        heading: "Agent",
        items: [
          { type: "page", name: "Agent (act on your vault)", desc: PAGE_DESC.agent, items: agentItems({ plugin, storageBlurb }) },
          { type: "page", name: "Agent bridge — MCP server (desktop)", visible: () => !Platform.isMobile, desc: PAGE_DESC.mcpBridge, items: mcpItems({ plugin, update, tokenReveal: this.tokenReveal }) },
          { type: "page", name: "External tools — MCP client", desc: PAGE_DESC.mcpClient, items: mcpClientItems({ plugin, update }) },
          { type: "page", name: "Cloud (experimental)", desc: cloudDesc(this.storageBlurb()), items: [...cloudItems(cloud), ...repliesItems(cloud)] },
          { type: "page", name: "Publishing", desc: PAGE_DESC.publishing, items: publishItems({ plugin, update, storageBlurb }) },
        ],
      },
      {
        type: "group",
        heading: "Vault intelligence",
        items: [
          { type: "page", name: "Semantic search (local embeddings)", items: semanticItems({ plugin, update, offerIndexRebuild: (label) => offerIndexRebuild(this.app, label, () => this.plugin.semantic().rebuildSemanticIndex()) }) },
          { type: "page", name: "Local models (Ollama & endpoints)", desc: `${PAGE_DESC.localModels} ${PAGE_DESC.openaiCompat}`, items: localModelsItems({ plugin, detected: this.detectedModels, update, renderStatus }) },
          { type: "page", name: "Source capture (typed clips)", desc: PAGE_DESC.sourceCapture, items: sourceCaptureItems({ plugin }) },
          { type: "page", name: "Vault ontology (typed notes & relations)", items: ontologyItems() },
          { type: "page", name: "Research Desk & discovery", desc: PAGE_DESC.discovery, items: discoveryItems({ plugin }) },
        ],
      },
      {
        type: "group",
        heading: "Files, memory & privacy",
        items: [
          { type: "page", name: "Session memory", visible: () => !Platform.isMobile, desc: PAGE_DESC.memory, items: memoryItems() },
          { type: "page", name: "Files & tags", items: [...storageItems(), ...indexingItems()] },
          { type: "page", name: "What this plugin accesses (privacy)", items: privacyItems() },
          { type: "page", name: "Desktop-only features", visible: () => Platform.isMobile, items: desktopOnlyItems() },
        ],
      },
    ];
  }

  private renderStatus(el: HTMLElement, status: ProviderStatus): void {
    el.empty();
    el.toggleClass("is-ok", status.ok);
    el.toggleClass("is-err", !status.ok);
    el.setText((status.ok ? "✓ " : "✗ ") + status.detail);
  }
}
