// The Companion chrome shared by every view: quick options, settings openers,
// and the recovery actions offered for failed or interrupted activity.

import { Platform, TFile, type App, type WorkspaceLeaf } from "obsidian";
import type { ActivityStore } from "../activity/store";
import type { ConversationsController } from "../conversations/controller";
import type { DesktopFeature } from "../integrations/desktopFeature";
import { OBSIDIAN_GENERAL_SETTINGS_TAB } from "../integrations/desktop";
import type { MemoryController } from "../memory/controller";
import type { OrdersController } from "../orders/controller";
import { sanitizeEndpointForDisplay } from "../providers/endpointPolicy";
import type { ProviderRouter } from "../providers/router";
import { chatBackendOptions } from "../providers/runtimeBackend";
import { resolveModelId } from "../claude/models";
import { RESEARCH_MODELS, researchModelChip, type ResearchModel } from "../research/researchModel";
import { builtinModelById } from "../semantic/transformers/model";
import type { SemanticController } from "../semantic/controller";
import type { ClipperFeature } from "../sources/clipperFeature";
import type { PluginSettings } from "../types";
import { selectEmbedding } from "../settingsItems/actions";
import { ChatView } from "./ChatView";
import { offerIndexRebuild } from "./rebuildOffer";
import { SYSTEM_VIEW_TYPE, SystemView } from "./SystemView";
import type { CompanionChromeDependencies } from "./companionChrome";
import type { QuickOptionAction, QuickOptionChange, QuickOptionsState } from "./quickOptions";
import type { WorkspaceViews } from "./workspaceViews";

export interface CompanionShellDeps {
  app: App;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  activity: () => ActivityStore;
  router: () => ProviderRouter;
  semantic: () => SemanticController;
  memory: () => MemoryController;
  clipperSetup: () => ClipperFeature;
  desktopIntegrations: () => DesktopFeature;
  standingOrders: () => OrdersController;
  conversations: () => ConversationsController;
  views: () => WorkspaceViews;
  chatLeafFor: (conversationId: string) => WorkspaceLeaf | null;
}

export class CompanionShell {
  constructor(private deps: CompanionShellDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  companionChrome(): CompanionChromeDependencies {
    return {
      app: this.app,
      activity: this.deps.activity(),
      snapshot: () => this.quickOptionsSnapshot(),
      save: (change) => this.saveQuickOption(change),
      run: (action) => this.runQuickOption(action),
      openAllSettings: () => this.openCompanionSettings(),
      openDesktopIntegrations: () => this.deps.desktopIntegrations().open(),
      runActivityRecovery: (activityId, actionId) => this.runActivityRecovery(activityId, actionId),
      dismissActivity: (activityId) => this.deps.activity().dismiss(activityId),
    };
  }

  private quickOptionsSnapshot(): QuickOptionsState {
    const clipperStatus = this.deps.clipperSetup().status();
    const embeddingModel = this.settings.embeddingEngine === "builtin"
      ? builtinModelById(this.settings.builtinEmbeddingModel).hfRepo.split("/").at(-1) ?? "Built-in model"
      : this.settings.embeddingEngine === "ollama"
        ? this.settings.embeddingModel
        : this.settings.openaiCompatEmbeddingModel;
    const utilityEndpoint = this.settings.utilityBackend === "ollama"
      ? sanitizeEndpointForDisplay(this.settings.ollamaHost)
      : this.settings.utilityBackend === "custom"
        ? sanitizeEndpointForDisplay(this.settings.openaiCompatHost)
        : undefined;
    return {
      isMobile: Platform.isMobile,
      chatBackend: this.deps.router().chatBackend,
      chatModel: resolveModelId(this.settings.model, this.settings.customModel),
      agentModeEnabled: this.settings.agentModeEnabled,
      vaultContextEnabled: this.settings.context.searchVault,
      memoryIngestOnSave: this.settings.memoryIngestOnSave,
      utilityBackend: this.settings.utilityBackend,
      ...(utilityEndpoint ? { utilityEndpoint } : {}),
      sourceEnrichOnCreate: this.settings.sourceEnrichOnCreate,
      sourceInboxFolder: this.settings.sourceInboxFolder,
      sourceCaptureEnabled: this.settings.sourceCaptureEnabled,
      clipperStatus,
      semanticEnabled: this.settings.semanticEnabled,
      embeddingEngine: this.settings.embeddingEngine,
      embeddingModel,
      ...this.deps.semantic().indexerHealth(),
      memoryEnabled: this.settings.memoryEnabled,
      memoryFolder: this.settings.memoryFolder,
      memoryAutoConsolidate: this.settings.memoryAutoConsolidate,
      discoveryEnabled: this.settings.discoveryEnabled,
      researchModel: this.settings.researchModel,
      researchModelLabel: researchModelChip(this.deps.router().researchStatus()).text,
    };
  }

  private async saveQuickOption(change: QuickOptionChange): Promise<void> {
    const value = change.value;
    switch (change.id) {
      case "chat-backend":
        if (typeof value === "string" && Object.hasOwn(chatBackendOptions(Platform.isMobile), value)) this.settings.chatBackend = value as PluginSettings["chatBackend"];
        else throw new Error("Choose a valid chat backend.");
        break;
      case "agent-mode": this.settings.agentModeEnabled = value === true; break;
      case "vault-context": this.settings.context.searchVault = value === true; break;
      case "memory-capture": this.settings.memoryIngestOnSave = value === true; break;
      case "utility-backend":
        if (value === "claude" || value === "ollama" || value === "custom") this.settings.utilityBackend = value;
        else throw new Error("Choose a valid utility backend.");
        break;
      case "auto-enrich":
        this.settings.sourceEnrichOnCreate = value === true;
        if (value === true) this.settings.sourceCaptureConsent = "allow";
        break;
      case "inbox-folder": this.settings.sourceInboxFolder = String(value).trim() || "Clippings"; break;
      case "source-capture": this.settings.sourceCaptureEnabled = value === true; break;
      case "semantic-search": this.settings.semanticEnabled = value === true; break;
      case "embedding-engine":
        if (value !== "builtin" && value !== "ollama" && value !== "custom") throw new Error("Choose a valid embedding engine.");
        {
          const notes = (await this.deps.semantic().indexer()?.stats().catch(() => null))?.notes ?? 0;
          const r = selectEmbedding(this.settings, { key: "embeddingEngine", value }, notes);
          if (!r.changed) return;
          await this.deps.saveSettings();
          if (r.rebuildLabel !== null) offerIndexRebuild(this.app, r.rebuildLabel, () => this.deps.semantic().rebuildSemanticIndex());
        }
        return;
      case "memory-enabled": this.settings.memoryEnabled = value === true; break;
      case "memory-folder": this.settings.memoryFolder = String(value).trim() || "Claude/Memory"; break;
      case "discovery-enabled": this.settings.discoveryEnabled = value === true; break;
      case "research-model":
        if (RESEARCH_MODELS.includes(value as ResearchModel)) this.settings.researchModel = value as ResearchModel;
        else throw new Error("Choose a valid research model.");
        break;
      default: throw new Error("That quick setting is not available.");
    }
    await this.deps.saveSettings();
  }

  private async runQuickOption(action: QuickOptionAction): Promise<void> {
    switch (action.id) {
      case "clipper-schemas": this.deps.clipperSetup().openSetup(); return;
      case "embedding-health":
      case "embedding-settings": this.openCompanionSettings(); return;
      case "rebuild-index":
      case "retry-index": await this.deps.semantic().rebuildSemanticIndex(); return;
      case "consolidate-memory": await this.deps.memory().consolidateMemory(); return;
      case "refresh-system":
        for (const leaf of this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)) if (leaf.view instanceof SystemView) await leaf.view.render();
        return;
      case "clippings-inbox": await this.deps.views().activateInboxView(); return;
      case "review-inbox-failures": await this.deps.views().activateInboxView(); return;
      case "utility-settings": this.openCompanionSettings(); return;
      case "download-builtin": await this.deps.semantic().downloadBuiltinModelAndIndex(); return;
      case "use-builtin-embeddings":
        this.settings.embeddingEngine = "builtin";
        await this.deps.saveSettings();
        if (!(await this.deps.semantic().canEmbedWithoutDownload())) await this.deps.semantic().downloadBuiltinModelAndIndex();
        else await this.deps.semantic().rebuildSemanticIndex();
        return;
      case "all-settings": this.openCompanionSettings(); return;
      default: throw new Error("That quick action is not available yet.");
    }
  }

  openCompanionSettings(): void {
    this.openSettingsTab("claude-companion");
  }

  /** Obsidian's General tab, which owns the CLI switch and its Register action. */
  openObsidianCliSettings(): void {
    this.openSettingsTab(OBSIDIAN_GENERAL_SETTINGS_TAB);
  }

  private openSettingsTab(tabId: string): void {
    const app = this.app as App & {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
      commands?: { executeCommandById?: (id: string) => boolean };
    };
    if (app.setting?.open) {
      app.setting.open();
      app.setting.openTabById?.(tabId);
      return;
    }
    app.commands?.executeCommandById?.("app:open-settings");
  }

  async runActivityRecovery(activityId: string, actionId: string): Promise<void> {
    const conversations = this.deps.conversations();
    if (activityId.startsWith("order:")) {
      if (actionId === "retry") return this.deps.standingOrders().retry(activityId);
      const orderId = activityId.slice("order:".length).replace(/:\d+$/, "");
      const file = this.app.vault.getAbstractFileByPath(orderId);
      if (!(file instanceof TFile)) throw new Error(`Order note missing: ${orderId}`);
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    if (activityId.startsWith("chat-turn:")) {
      const conversationId = activityId.slice("chat-turn:".length);
      const conversation = conversations.list().find(({ id }) => id === conversationId);
      if (!conversation) throw new Error("That conversation no longer exists.");
      if (actionId === "stop-chat-turn") {
        if (!conversation.activeTurn) return;
        await conversations.stopTurn(conversationId, conversation.activeTurn.id);
        return;
      }
      await conversations.setActive(conversationId);
      const existingLeaf = this.deps.chatLeafFor(conversationId);
      let view: ChatView | null;
      if (existingLeaf) {
        await this.app.workspace.revealLeaf(existingLeaf);
        view = existingLeaf.view instanceof ChatView ? existingLeaf.view : null;
      } else {
        view = await this.deps.views().activateView();
      }
      view?.loadConversation(conversations.getActive() ?? conversation);
      if (actionId === "resume-chat-turn") {
        const active = conversations.getActive();
        if (view && active) await view.resumeInterruptedTurn(active);
      }
      return;
    }
    if (actionId === "copy-diagnostics") {
      const logPath = "Claude/enrichment-diagnostics.log";
      if (!(await this.app.vault.adapter.exists(logPath))) throw new Error("No enrichment diagnostics log exists yet — set enrichmentDiagnostics to true in the plugin data.json and run Enrich all again.");
      const text = await this.app.vault.adapter.read(logPath);
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable on this device.");
      await navigator.clipboard.writeText(text.slice(-8192));
      return;
    }
    if (actionId === "copy-details") {
      const details = this.deps.activity().snapshot().records.find(({ id }) => id === activityId)?.technicalDetails;
      if (!details) throw new Error("No technical details are available for this activity.");
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable on this device.");
      await navigator.clipboard.writeText(details);
      return;
    }
    await this.runQuickOption({ id: actionId, page: "related", activityId });
  }
}
