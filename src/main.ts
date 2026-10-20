import { registerNativeResultImport } from "./native/controller";
import { registerDeviceGpuCheck } from "./device/controller";
import { DeviceChatClient } from "./device/client";
import { DeviceProvider } from "./providers/device";
import { createEmbedWorker } from "./semantic/transformers/workerSource";
import { FileSystemAdapter, MarkdownView, Notice, parseYaml, Platform, Plugin, requestUrl, WorkspaceLeaf } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./view/ChatView";
import { MemoryView, MEMORY_VIEW_TYPE } from "./view/MemoryView";
import { InboxView, INBOX_VIEW_TYPE } from "./view/InboxView";
import { SystemView, SYSTEM_VIEW_TYPE } from "./view/SystemView";
import { buildChat, type ChatCluster } from "./composition/chat";
import { buildCommandActions } from "./composition/commands";
import {
  buildClipperSetup,
  buildDesktopIntegrations,
  buildLivingSources,
  buildNoteFlows,
  buildOnboarding,
  buildOrders,
  buildPublishing,
  buildResearch,
  buildShell,
  buildUtilityRouting,
  buildWorkspaceViews,
} from "./composition/features";
import { buildClippings, buildEnrichment, buildMemory, buildSemantic } from "./composition/knowledge";
import { buildBuildController, buildMcpBridge, buildOptimize } from "./composition/runtime";
import { buildSystemDeps } from "./composition/system";
import { vaultToolOptions } from "./composition/vaultTools";
import { RelatedView, RELATED_VIEW_TYPE } from "./view/RelatedView";
import { ResearchView, ResearchWorkbenchRedirect, RESEARCH_DESK_VIEW_TYPE, RESEARCH_WORKBENCH_VIEW_TYPE } from "./view/ResearchView";
import { BuildView, BUILD_VIEW_TYPE } from "./view/BuildView";
import { SimilarBasesView, SIMILAR_BASES_VIEW_TYPE } from "./view/SimilarBasesView";
import { ensureVaultFolder, uniqueNotePath } from "./vault/vaultFiles";
import { listChatProjects } from "./projects/registry";
import { ProjectPicker } from "./projects/ProjectPicker";
import { projectSystemPrompt, projectNoteBody, type ChatProject } from "./projects/model";
import { PROVENANCE_LANGUAGE } from "./research/draftSections";
import type { LivingSources } from "./living/feature";
import { LIVING_STATUS_LANGUAGE } from "./living/view";
import { renderProvenanceReferences } from "./view/research/provenanceReferences";
import type { ChatTurnService } from "./chat/turnService";
import type { MemoryController } from "./memory/controller";
import type { McpBridgeController } from "./mcp/bridgeController";
import { ClaudeCompanionSettingTab } from "./settings";
import { companionCommands, type CommandActions } from "./commands/definitions";
import { ProviderRouter } from "./providers/router";
import type { UtilityRouting } from "./providers/utilityRouting";
import type { ClipperFeature } from "./sources/clipperFeature";
import type { Onboarding } from "./onboarding/onboarding";
import { DEFAULT_SETTINGS, type PluginSettings, type ArtifactOpenTarget } from "./types";
import { DESIGN_SYSTEM_PROMPT } from "./artifacts/designSystem";
import { AGENT_INSTRUCTION, PLAN_MODE_INSTRUCTION } from "./agent/prompt";
import { inlineDiffExtension } from "./editor/inlineDiffExtension";
import { reviewInlineWithKeys } from "./editor/reviewKeys";
import { selectionActionExtension } from "./editor/selectionAction";
import { editorViewOf } from "./editor/reviewEdits";
import { inlinePromptExtension, openInlinePrompt } from "./editor/inlinePrompt";
import { commitModalRewrite, inlineEditMenuTitle, planModalRewrite, runInlineEdit, type ModalRewrite } from "./editor/inlineEdit";
import { DiffModal } from "./view/DiffModal";
import { ARTIFACT_HEIGHT, renderArtifactInline, ArtifactModal, openArtifactExternally } from "./artifacts/renderInline";
import type { McpHttpServer } from "./mcp/server";
import { VaultTools } from "./mcp/vaultTools";
import { catalogPromptProvider, composeResourceProviders, substrateResourceProvider, vaultResourceProvider } from "./mcp/providers";
import { MEMORY_NOTE_BASENAME } from "./memory/consolidate";
import { ExternalMcpManager } from "./mcp/externalManager";
import { externalAnthropicTools } from "./mcp/external";
import type { AnthropicToolDef } from "./providers/types";
import { toolAccess, type ToolRunKind } from "./agent/toolAccess";
import { parseTemplateNote, TEMPLATE_SCAFFOLD, type PromptTemplate } from "./templates/promptTemplates";
import type { OrdersController } from "./orders/controller";
import type { OrdersFeature } from "./orders/ordersFeature";
import type { PublishFeature } from "./publish/publishFeature";
import type { ResearchFeature } from "./research/researchFeature";
import type { DesktopFeature } from "./integrations/desktopFeature";
import type { ClippingsController } from "./sources/clippings";
import { stripFrontmatter } from "./markdown/frontmatter";
import { generateToken } from "./mcp/clientConfig";
import type { BridgeSetupInput } from "./integrations/desktopRuntime";
import type { AgentTurnRunner } from "./agent/loop";
import { CliSession } from "./cli/session";
import { CliSessionPool, type PoolEntry } from "./cli/sessionPool";
import { mcpConfigJson } from "./cli/argv";
import { bridgeTools, CLI_HIDDEN_TOOLS, cliAllowedTools, type InteractiveToolDeps } from "./cli/bridgeTools";
import { createNodeCliRuntime, type CliRuntime } from "./cli/runtime";
import { CliProvider } from "./providers/cliProvider";
import { claudeBackend } from "./cli/backends/claude";
import { codexBackend } from "./cli/backends/codex";
import { opencodeBackend } from "./cli/backends/opencode";
import type { CliBackend } from "./cli/backends/types";
import { type BuildRun } from "./build/run";
import type { BuildController } from "./build/controller";
import type { PublishController } from "./publish/controller";
import type { OptimizeFeature } from "./optimize/feature";
import { normalizeOptimizeState, type OptimizeState } from "./optimize/state";
import { loadedOntology } from "./optimize/vaultGlue";
import type { SemanticController } from "./semantic/controller";
import { isNamespacedData, resolveSettings } from "./settingsLoad";
import { createSecretStore, hydrate, stripVerifiedSecrets, syncSecrets, type SecretField, type SecretStore } from "./secrets/store";
import { migrateSecrets, migrationNotice } from "./secrets/migrate";
import {
  type Conversation,
  type ConversationState,
  emptyState,
  fromPersisted,
} from "./conversations/store";
import { ConversationsController } from "./conversations/controller";
import type { SessionActions } from "./conversations/sessionActions";
import { normalizePath, TFile, TFolder, type Editor } from "obsidian";
import type { SourceEnrichmentController } from "./sources/controller";
import { OntologyRegistry } from "./ontology/registry";
import { captureWebSource } from "./research/webCapture";
import type { WebCapture } from "./context/webCapture";
import { ActivityStore } from "./activity/store";
import { beginActivity } from "./activity/progress";
import { EnrichDiagnostics } from "./sources/enrichDiagnostics";
import type { DesktopIntegrationRuntime } from "./integrations/desktopCoordinator";
import type { NoteFlows } from "./enrich/noteFlows";
import type { WorkspaceViews } from "./view/workspaceViews";
import type { CompanionShell } from "./view/companionShell";
import type { DesktopPlatform } from "./integrations/desktop";

/** Shape of this plugin's persisted data.json (settings + chat history). */
interface PersistedData {
  settings?: Partial<PluginSettings>;
  conversations?: Conversation[];
  activeConversationId?: string | null;
  buildRuns?: BuildRun[];
  activeBuildRunId?: string | null;
  standingOrders?: unknown;
  orderEditQueue?: unknown;
  published?: unknown;
  optimize?: unknown;
}

export default class ClaudeCompanionPlugin extends Plugin {
  override settings: PluginSettings = DEFAULT_SETTINGS;
  private _activity?: ActivityStore;
  get activity(): ActivityStore { return this._activity ??= new ActivityStore(); }
  private _enrichDiagnostics?: EnrichDiagnostics;
  /** Opt-in phase log for batch enrichment; lazy getter so partial test harnesses (no onload) never touch it unless enabled. */
  get enrichDiagnostics(): EnrichDiagnostics {
    return this._enrichDiagnostics ??= new EnrichDiagnostics(
      {
        append: async (path, text) => {
          const dir = path.slice(0, path.lastIndexOf("/"));
          if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
          await this.app.vault.adapter.append(path, text);
        },
        now: () => Date.now(),
        isMobile: Platform.isMobile,
        path: "Claude/enrichment-diagnostics.log",
      },
      () => this.settings.enrichmentDiagnostics,
    );
  }
  private convState: ConversationState = emptyState();
  private _clippings?: ClippingsController;
  private _chat?: ChatCluster;
  private chat(): ChatCluster {
    return this._chat ??= buildChat(this, {
      state: { get: () => this.convState, set: (next) => { this.convState = next; } },
      onUnattachedTurnDone: (conversationId, title) => this.showTurnCompleteStatusBar(conversationId, title),
    });
  }
  conversations(): ConversationsController { return this.chat().conversations(); }
  sessionActions(): SessionActions { return this.chat().sessionActions(); }
  private turnCompleteStatusBarEl: HTMLElement | null = null;
  /** Owns in-flight chat turns independent of any ChatView instance (P5). */
  turnService(): ChatTurnService { return this.chat().turnService(); }

  /** Desktop status-bar item pointing at a turn that finished unattended; clears itself once clicked. */
  private showTurnCompleteStatusBar(conversationId: string, title: string): void {
    if (Platform.isMobile) return;
    this.turnCompleteStatusBarEl?.remove();
    const el = this.addStatusBarItem();
    el.addClass("cc-turn-complete-status");
    el.setAttr("role", "status");
    const action = el.createEl("button", {
      cls: "cc-turn-complete-action",
      text: `Reply ready: ${title}`,
      attr: { type: "button", title },
    });
    action.addEventListener("click", () => {
      el.remove();
      if (this.turnCompleteStatusBarEl === el) this.turnCompleteStatusBarEl = null;
      void this.openConversationFromNotice(conversationId);
    });
    this.turnCompleteStatusBarEl = el;
  }

  private async openConversationFromNotice(conversationId: string): Promise<void> {
    const conversation = await this.conversations().setActive(conversationId);
    if (!conversation) return;
    const existing = this.chatLeafFor(conversationId);
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const view = await this.views().activateView();
    if (view) view.loadConversation(conversation);
  }

  /** A Chat leaf already showing `conversationId`, if one is open. */
  chatLeafFor(conversationId: string): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView && leaf.view.getState().conversationId === conversationId) return leaf;
    }
    return null;
  }

  private _build: BuildController | null = null;
  private build(): BuildController {
    return (this._build ??= buildBuildController(this, { desktopRuntimeLoader: () => this._desktopRuntimeLoader() }));
  }
  /** data.json contains several domains; serialize snapshots so an older write cannot land last. */
  private persistChain: Promise<void> = Promise.resolve();
  /** Credentials live here, not in data.json. Lazy so tests can construct the plugin. */
  private _secrets: SecretStore | null = null;
  /** Set by the last persist: credentials the store refused, still in data.json. */
  private unverifiedSecrets: SecretField[] = [];
  private _router: ProviderRouter | null = null;
  /** Owns the sign-in probe across router rebuilds (settings saves null the router) — one per CLI backend. */
  private _cliProvider: CliProvider | null = null;
  private _codexProvider: CliProvider | null = null;
  private _opencodeProvider: CliProvider | null = null;
  private _cliPool?: CliSessionPool<CliSession>;
  private get cliPool(): CliSessionPool<CliSession> {
    return (this._cliPool ??= new CliSessionPool<CliSession>(3));
  }
  private _cliRuntime: CliRuntime | null | undefined;
  private _desktopRuntimeLoader: () => Promise<{
    createNodeDesktopRuntime(platform: DesktopPlatform, homeDir: string, env: Record<string, string | undefined>, bridge?: BridgeSetupInput): Promise<DesktopIntegrationRuntime>;
    createNodeManagedProcessPort(): import("./build/desktopExecutor").ManagedProcessPort;
  }> = () => import("./integrations/desktopRuntime");
  private _externalMcp: ExternalMcpManager | null = null;
  private _mcpServersSnapshot = "[]";
  /** Chat-scoped vault tools (agent mode) — separate instance and write gate from the MCP bridge. */
  private agentVaultTools: VaultTools | null = null;
  private mcpLifecycleGeneration = 0;
  private mcpLifecycleEnded = false;
  private _mcpBridge: McpBridgeController | null = null;
  memoryNotePath(): string {
    return normalizePath(`${this.settings.memoryFolder}/${MEMORY_NOTE_BASENAME}.md`);
  }
  private mcpBridge(): McpBridgeController {
    return (this._mcpBridge ??= buildMcpBridge(this, {
      isLifecycleEnded: () => this.mcpLifecycleEnded,
      lifecycleGeneration: () => this.mcpLifecycleGeneration ?? 0,
    }));
  }
  private _semantic: SemanticController | null = null;
  semantic(): SemanticController {
    return (this._semantic ??= buildSemantic(this));
  }
  private _enrichment: SourceEnrichmentController | null = null;
  enrichment(): SourceEnrichmentController {
    return (this._enrichment ??= buildEnrichment(this));
  }
  private _memory: MemoryController | null = null;
  memory(): MemoryController {
    return (this._memory ??= buildMemory(this));
  }
  private _utilityRouting?: UtilityRouting;
  /** Runtime utility selection, mobile fallback consent, and the unload lifecycle for utility work. */
  utilityRouting(): UtilityRouting {
    return (this._utilityRouting ??= buildUtilityRouting(this));
  }
  private _clipperSetup?: ClipperFeature;
  /** Web Clipper template export, setup modal, and clip verification. */
  clipperSetup(): ClipperFeature {
    return (this._clipperSetup ??= buildClipperSetup(this));
  }
  private _onboarding?: Onboarding;
  /** Setup wizard, first-run prompts, and ontology seeding. */
  onboarding(): Onboarding {
    return (this._onboarding ??= buildOnboarding(this));
  }
  private _noteFlows?: NoteFlows;
  /** Link suggestions, "Tidy with Claude", and frontmatter suggestions. */
  noteFlows(): NoteFlows {
    return (this._noteFlows ??= buildNoteFlows(this));
  }
  private _views?: WorkspaceViews;
  /** Workspace leaves, the active-note card, workflows, and the Source inbox badge. */
  views(): WorkspaceViews {
    return (this._views ??= buildWorkspaceViews(this));
  }
  private _shell?: CompanionShell;
  /** Quick options, settings openers, and activity recovery shared by every view. */
  shell(): CompanionShell {
    return (this._shell ??= buildShell(this));
  }
  private _research?: ResearchFeature;
  /** Research Desk, scholarly discovery, and the plan-to-build handoff. */
  research(): ResearchFeature {
    return (this._research ??= buildResearch(this, { build: () => this.build() }));
  }
  private _desktopIntegrations?: DesktopFeature;
  /** Desktop integrations modal and the read-only bridge it prepares. */
  desktopIntegrations(): DesktopFeature {
    return (this._desktopIntegrations ??= buildDesktopIntegrations(this, {
      resolvedMcpToken: () => this.resolvedMcpToken(),
      runtimeLoader: () => this._desktopRuntimeLoader(),
    }));
  }
  private _orders?: OrdersFeature;
  /** Standing orders, their queued edits, and the persisted state behind both. */
  orders(): OrdersFeature {
    return (this._orders ??= buildOrders(this, { closeCliSession: (conversationId) => this.cliPool.close(conversationId) }));
  }
  private _publishing?: PublishFeature;
  /** Gist publishing, the published-note registry, and cloud session dispatch. */
  publishing(): PublishFeature {
    return (this._publishing ??= buildPublishing(this));
  }
  private _living?: LivingSources;
  /** Living views bound to typed source notes. */
  livingSources(): LivingSources {
    return (this._living ??= buildLivingSources(this));
  }
  private optimizeState: OptimizeState = { dismissed: [], verdicts: {} };
  private _optimize?: OptimizeFeature;
  /** Lazily-built ontology registry; null while the feature is disabled. */
  private _ontology: OntologyRegistry | null = null;
  /** Teardown callbacks registered by extracted controllers; run in reverse order on unload. */
  private disposables?: Array<() => void>;
  /** Listeners notified after every successful saveSettings() (per-domain reactions). */
  private settingsListeners?: Set<() => void>;

  /** Register a teardown callback run by onunload (reverse registration order). */
  registerDisposable(dispose: () => void): void {
    (this.disposables ??= []).push(dispose);
  }

  /** Subscribe to successful settings saves. Returns an unsubscribe function. */
  onSettingsChanged(listener: () => void): () => void {
    const listeners = (this.settingsListeners ??= new Set());
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  override async onload(): Promise<void> {
    this.mcpLifecycleGeneration = (this.mcpLifecycleGeneration ?? 0) + 1;
    this.mcpLifecycleEnded = false;
    this.utilityRouting().start();
    this._enrichment?.resetLifecycle();
    await this.loadSettings();

    this.registerViews();

    this.registerArtifactBlocks();

    this.registerEditorExtension(inlineDiffExtension());
    this.registerEditorExtension(inlinePromptExtension());
    if (Platform.isDesktop) {
      this.registerEditorExtension(
        selectionActionExtension({
          enabled: () => this.settings.selectionActionEnabled,
          run: () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) void this.startInlineEdit(view.editor, view);
          },
        }),
      );
    }

    // One ribbon icon for the plugin itself. Workflows and session capture live
    // in the chat panel's header action bar, so they don't need ribbon entries.
    this.addRibbonIcon("sparkles", "Open Companion for Claude", () => void this.views().activateView());
    const inboxRibbon = this.addRibbonIcon("inbox", "Source inbox", () => void this.views().activateInboxView());
    this.views().setInboxRibbon(inboxRibbon);
    inboxRibbon.addClass("cc-inbox-ribbon");

    this.registerContextMenus();
    for (const command of companionCommands(this.commandActions())) this.addCommand(command);
    registerNativeResultImport(this);
    registerDeviceGpuCheck(this);
    this.addCommand({
      id: "set-chat-project",
      name: "Chat: choose project",
      callback: () => void (async () => {
        const view = await this.views().activateView();
        if (!view) return;
        const projects = await this.listChatProjects();
        if (projects.length === 0) {
          new Notice("No chat projects yet — create one with “Chat: new project note”.");
          return;
        }
        new ProjectPicker(this.app, projects, (project) => void view.applyChosenProject(project)).open();
      })(),
    });
    this.addCommand({
      id: "new-chat-project",
      name: "Chat: new project note",
      callback: () => void (async () => {
        const folder = "Claude/Projects";
        await ensureVaultFolder(this.app, folder);
        const activeFolder = this.app.workspace.getActiveFile()?.parent?.path ?? null;
        const path = await uniqueNotePath(this.app, folder, "New project", "md");
        const file = await this.app.vault.create(path, projectNoteBody(activeFolder));
        await this.app.workspace.getLeaf(true).openFile(file);
      })(),
    });

    this.addSettingTab(new ClaudeCompanionSettingTab(this.app, this));

    // Start the MCP bridge if enabled (deferred so it doesn't block load).
    this.app.workspace.onLayoutReady(() => {
      this.startAfterLayout();
    });

    this.registerNoteTracking();
  }

  /** Every view Companion contributes, with the dependencies each one needs. */
  private registerViews(): void {
    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));
    this.registerView(MEMORY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new MemoryView(leaf, this));
    this.registerView(INBOX_VIEW_TYPE, (leaf: WorkspaceLeaf) => new InboxView(leaf, this));
    this.registerView(SYSTEM_VIEW_TYPE, (leaf: WorkspaceLeaf) => new SystemView(leaf, this, buildSystemDeps(this)));
    this.registerView(RELATED_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RelatedView(leaf, this));
    this.registerView(BUILD_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BuildView(leaf, this.build().viewDependencies()));
    this.registerView(RESEARCH_DESK_VIEW_TYPE, (leaf: WorkspaceLeaf) => this.research().createDeskView(leaf));
    this.registerView(RESEARCH_WORKBENCH_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ResearchWorkbenchRedirect(leaf));
    this.registerBasesView(SIMILAR_BASES_VIEW_TYPE, {
      name: "Similar notes",
      icon: "sparkles",
      factory: (controller, containerEl) => new SimilarBasesView(controller, containerEl, {
        semanticEnabled: () => this.settings.semanticEnabled,
        related: (path, k, accept) => this.semantic().relatedForTools(path, k, accept),
      }),
      options: () => [{ type: "slider", key: "limit", displayName: "Results", min: 5, max: 50, step: 1, default: 20 }],
    });
  }

  /** Inline interactive artifacts, rendered from claude-html fences. */
  private registerArtifactBlocks(): void {
    // Inline interactive artifacts: ```claude-html ... ```
    this.registerMarkdownCodeBlockProcessor("claude-html", (source, el, ctx) => {
      let height = ARTIFACT_HEIGHT;
      let title = "Claude artifact";
      const info = ctx.getSectionInfo(el);
      if (info) {
        const fence = info.text.split("\n")[info.lineStart] ?? "";
        const m = /height=(\d+)/.exec(fence);
        if (m?.[1]) height = parseInt(m[1], 10);
      }
      const t = /<title>([^<]+)<\/title>/i.exec(source);
      if (t?.[1]) title = t[1].trim();
      renderArtifactInline(el, source, height, title, {
        open: (h, ti) => this.openArtifact(h, ti),
        openWith: (h, ti, target) => this.openArtifactWith(h, ti, target),
        publish: (h, ti) => void this.publish().publishArtifact(h, ti),
      });
    });
    this.registerMarkdownCodeBlockProcessor(PROVENANCE_LANGUAGE, (source, el, ctx) => {
      renderProvenanceReferences(el, source, (path) => void this.app.workspace.openLinkText(path, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor(LIVING_STATUS_LANGUAGE, (_source, el, ctx) => this.livingSources().renderStatus(el, ctx.sourcePath));
  }

  /**
   * Work deferred to layout-ready. Vault listeners register here so Obsidian's
   * initial scan does not fire create/modify for every note and stampede them.
   */
  private startAfterLayout(): void {
    const cliProbe = Platform.isMobile ? undefined : this.chatCliProvider().refresh().then(() => this.refreshViews());
      void this.syncMcpServer();
      this.research().syncPlanBuildActions();
      void this.onboarding().runFirstRun(cliProbe).then(() => this.semantic().catchUpIndex());
      // Schemas/inbox changed since the clipper templates were exported →
      // the clipper is clipping against a stale schema. Offer once per session.
      if (this.settings.sourceCaptureEnabled && this.clipperSetup().templatesStale()) {
        new Notice("Source schemas changed since your Web Clipper templates were exported — re-export from Settings → Source capture.", 9000);
      }

      // Keep the semantic index fresh as notes change (debounced; no-op when
      // off). Registered AFTER layout-ready so Obsidian's initial vault scan
      // doesn't fire create/modify for every note and stampede the indexer;
      // catchUpIndex covers notes that changed while Obsidian was closed.
      this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile && (f.extension === "md" || (f.extension === "pdf" && this.settings.semanticIndexPdfs))) this.semantic().queueReindex(f.path); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile && (f.extension === "md" || (f.extension === "pdf" && this.settings.semanticIndexPdfs))) this.semantic().queueReindex(f.path); }));
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof TFile && (f.extension === "md" || f.extension === "csv") && this.settings.sourceCaptureEnabled && this.settings.sourceEnrichOnCreate) this.enrichment().queueEnrich(f);
      }));
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof TFile && f.extension === "md") this.clipperSetup().queueVerification(f);
      }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile && (f.extension === "md" || f.extension === "pdf")) void this.semantic().indexer()?.removeNote(f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f instanceof TFile && (f.extension === "md" || f.extension === "pdf")) void this.semantic().renameNote(oldPath, f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { void this.conversations().renameAttachments(oldPath, f.path).catch((error: unknown) => new Notice(`Couldn't save renamed chat attachments: ${error instanceof Error ? error.message : String(error)}`)); }));
      this.registerEvent(this.app.vault.on("delete", (f) => { void this.conversations().invalidateCitations(f.path).catch((error: unknown) => new Notice(`Couldn't save deleted source references: ${error instanceof Error ? error.message : String(error)}`)); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f.path.endsWith(".md")) this.research().scheduleResearchRefresh(f.path); }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f.path.endsWith(".md")) this.research().scheduleResearchRefresh(f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f.path.endsWith(".md") || oldPath.endsWith(".md")) this.research().scheduleResearchRefresh(f.path, oldPath); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f instanceof TFile && f.extension === "md") void this.publish().renameNote(oldPath, f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { void this.build().renameDocuments(oldPath, f.path); }));

      // Inbox ribbon badge: pending count, refreshed on vault + frontmatter
      // changes (debounced — enrichment stamps source_enriched via frontmatter).
      this.views().syncInboxBadge();
      this.registerEvent(this.app.vault.on("create", () => this.views().scheduleInboxBadgeSync()));
      this.registerEvent(this.app.vault.on("delete", () => this.views().scheduleInboxBadgeSync()));
      this.registerEvent(this.app.vault.on("rename", () => this.views().scheduleInboxBadgeSync()));
      this.registerEvent(this.app.metadataCache.on("changed", () => this.views().scheduleInboxBadgeSync()));

      // Reload the ontology when schema notes under the ontology folder change
      // (debounced; no-op while the feature is off).
      const inOntology = (path: string): boolean => path.startsWith(`${normalizePath(this.settings.ontologyFolder)}/`);
      this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && inOntology(f.path)) this.onboarding().scheduleOntologyReload(); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && inOntology(f.path)) this.onboarding().scheduleOntologyReload(); }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && inOntology(f.path)) this.onboarding().scheduleOntologyReload(); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && (inOntology(f.path) || inOntology(oldPath))) this.onboarding().scheduleOntologyReload(); }));

      this.orders().start();
  }

  /** Keeps the plan Build action and the last-seen note in step with the workspace. */
  private registerNoteTracking(): void {
    // Show a "Build" action in the header of any `type: plan` note.
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file?.extension === "md") this.lastMarkdownFile = file;
      this.research().syncPlanBuildActions();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.research().syncPlanBuildActions()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (file) this.lastMarkdownFile = file;
    }));
    // Active = last focused chat leaf: track it for activateView()'s reuse
    // preference, and point the store's active conversation at it so a save
    // from a background tab never steals the slot the user is looking at.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!(leaf?.view instanceof ChatView)) return;
      this.views().lastFocusedChatLeaf = leaf;
      const id = leaf.view.getState().conversationId;
      if (typeof id === "string" && id !== this.convState.activeId) void this.conversations().setActive(id);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.research().syncPlanBuildActions()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.research().scheduleResearchRefresh(file.path);
    }));
  }

  /** Right-click entries that mirror commands, on a selection and in the file explorer. */
  private registerContextMenus(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        menu.addItem((item) =>
          item
            .setTitle(inlineEditMenuTitle(editor.getSelection()))
            .setIcon("sparkles")
            .onClick(() => void this.startInlineEdit(editor, view)),
        );
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Tidy with Claude…")
              .setIcon("sparkles")
              .onClick(() => void this.noteFlows().enrichNoteFlow(file)),
          );
          if (this.livingSources().kindOf(file)) {
            menu.addItem((item) => item.setTitle("Open living view").setIcon("layout-dashboard").onClick(() => void this.livingSources().open(file)));
          }
          const published = this.publishing().publishedItems().some((entry) => entry.key === file.path);
          menu.addItem((item) =>
            item
              .setTitle(published ? "Republish to GitHub Gist" : "Publish note to GitHub Gist")
              .setIcon("share-2")
              .onClick(() => void this.publish().publishNote(file.path)),
          );
          if (published) {
            menu.addItem((item) =>
              item
                .setTitle("Copy published link")
                .setIcon("link")
                .onClick(() => void this.publish().copyLink(file.path)),
            );
            menu.addItem((item) =>
              item
                .setTitle("Unpublish from GitHub Gist")
                .setIcon("trash")
                .onClick(() => void this.publish().unpublish(file.path)),
            );
          }
        } else if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle("Tidy notes with Claude…")
              .setIcon("sparkles")
              .onClick(() => void this.noteFlows().enrichFolderFlow(file)),
          );
          menu.addItem((item) =>
            item
              .setTitle("Organize notes into subfolders…")
              .setIcon("folder-tree")
              .onClick(() => void this.clippings().organizeFolder(file)),
          );
        }
      }),
    );
  }

  /** Everything `companionCommands` needs, so the definitions stay free of the plugin. */
  private commandActionsCache?: CommandActions;

  commandActions(): CommandActions {
    return this.commandActionsCache ??= buildCommandActions(this);
  }

  /** Turn vault search on for the active chat tab and tell the user which engine answers. */
  async enableVaultSearch(): Promise<void> {
    const view = await this.views().activateView();
    if (!view) return;
    view.enableVaultSearchForChat();
    view.refreshModelLabel();
    const how = this.settings.semanticEnabled ? "semantic + keyword" : "keyword";
    new Notice(`Vault search on for this chat (${how}) — ask your question in the chat panel.`);
  }

  clippings(): ClippingsController {
    return (this._clippings ??= buildClippings(this));
  }

  /** Enrich, infer a folder per clip, review, and move the inbox clippings. */
  async organizeClippings(): Promise<void> {
    return this.clippings().organizeClippings();
  }

  /** Most recently focused markdown file — side views (Desk, Chat) steal active-leaf, so "active note" flows must remember it. */
  lastMarkdownFile: TFile | null = null;

  /**
   * Edit with Claude at the cursor: the inline prompt opens over the
   * selection (rewrite) or at the cursor (insert); the flow lives in
   * editor/inlineEdit.ts and writes only through review.
   */
  async startInlineEdit(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file;
    const cm = editorViewOf(editor);
    if (!file || !cm) {
      new Notice("Open a note in the editor to edit with Claude.");
      return;
    }
    await runInlineEdit(
      { doc: editor.getValue(), from: editor.posToOffset(editor.getCursor("from")), to: editor.posToOffset(editor.getCursor("to")) },
      {
        path: file.path,
        inlineDiffEnabled: this.settings.inlineDiffEnabled,
        openPrompt: (opts) => openInlinePrompt(cm, opts),
        complete: async (req) => (await this.router().complete("chat", req)).text,
        currentDoc: () => cm.state.doc.toString(),
        review: (session) => reviewInlineWithKeys(this.app, cm, session),
        reviewModal: (rewrite) => this.reviewRewriteInModal(file, cm.state.doc.toString(), rewrite),
        notice: (message) => new Notice(message),
        begin: (label) => beginActivity(this.activity, label),
        failureMessage: (e) => {
          const message = e instanceof Error ? e.message : String(e);
          const hint = this.utilityRouting().providerErrorHint(message, this.router().resolve("chat").provider.id);
          return `Edit failed — ${hint ?? message}`;
        },
      },
    );
  }

  /**
   * Inline diff off: per-hunk DiffModal review → vault.process apply. When the
   * selection isn't unique in the note, the diff is planned against the
   * selection alone and the apply is anchored at the editor offsets.
   */
  private async reviewRewriteInModal(file: TFile, content: string, rewrite: ModalRewrite): Promise<void> {
    const prepared = planModalRewrite(content, rewrite);
    const accepted = await new Promise<boolean[] | null>((resolve) =>
      new DiffModal(this.app, { path: file.path, description: `Rewrite — ${rewrite.instruction}`, plan: prepared.plan }, resolve).open(),
    );
    if (!accepted) return;
    await commitModalRewrite((transform) => this.app.vault.process(file, transform), prepared, accepted, (message) => new Notice(message));
  }

  /** Group a folder's clippings into research themes and write its Triage.md board. */
  private async triageClippings(folderOverride?: string): Promise<void> {
    return this.clippings().triage(folderOverride);
  }

  /** Command-palette entry: pick the folder first so moved/organized notes can be triaged too. */
  async triageClippingsWithPicker(): Promise<void> {
    return this.clippings().triageWithPicker();
  }

  override onunload(): void {
    this._deviceChat?.cancel();
    for (const dispose of [...(this.disposables ?? [])].reverse()) dispose();
    this.disposables = [];
    this.settingsListeners?.clear();
    void this.closeCliSessions();
    for (const cli of [this._cliProvider, this._codexProvider, this._opencodeProvider]) cli?.cancelAll();
    this._activity?.dispose();
    this.utilityRouting().end();
    this._enrichment?.destroy();
    this._clipperSetup?.dispose();
    this._research?.dispose();
    this._desktopIntegrations?.dispose();
    this._build?.destroy();
    this.mcpLifecycleEnded = true;
    this.mcpLifecycleGeneration = (this.mcpLifecycleGeneration ?? 0) + 1;
    this._mcpBridge?.destroy();
    void this._externalMcp?.close();
    this._externalMcp = null;
    this._semantic?.destroy();
    this._onboarding?.dispose();
    this._views?.dispose();
    this._orders?.dispose();
  }

  /** Lazy external-MCP manager; null until first configured use. */
  externalMcp(): ExternalMcpManager {
    if (!this._externalMcp) this._externalMcp = new ExternalMcpManager(() => this.settings.mcpClientServers, this.manifest.version);
    return this._externalMcp;
  }

  /** External servers' namespaced tool lists (empty when none are configured/reachable). */
  async externalMcpTools(): Promise<AnthropicToolDef[]> {
    if (this.settings.mcpClientServers.every((s) => !s.enabled)) return [];
    return externalAnthropicTools(await this.externalMcp().servers());
  }

  /** Route an mcp__<server>__<tool> call to its server. */
  async callExternalMcp(name: string, args: Record<string, unknown>): Promise<string> {
    return this.externalMcp().call(name, args);
  }

  // ---------- settings ----------

  /** Obsidian's OS-encrypted secret store, or an unavailable one below 1.11.5. */
  secrets(): SecretStore {
    this._secrets ??= createSecretStore(this.app);
    return this._secrets;
  }

  /** Credentials the secret store would not accept on the last write. */
  secretsWriteFailures(): readonly SecretField[] {
    return this.unverifiedSecrets;
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as PersistedData | Partial<PluginSettings> | null;
    const loaded = resolveSettings(raw);
    this.convState = isNamespacedData(raw)
      ? fromPersisted({ conversations: raw.conversations, activeId: raw.activeConversationId })
      : emptyState();
    this.conversations().restoreTurnActivities();
    this.build().restoreState(
      isNamespacedData(raw) ? raw.buildRuns : undefined,
      isNamespacedData(raw) ? raw.activeBuildRunId : null,
    );
    this.orders().restore(isNamespacedData(raw) ? raw.standingOrders : undefined, isNamespacedData(raw) ? raw.orderEditQueue : undefined);
    this.publishing().restore(isNamespacedData(raw) ? raw.published : undefined);
    this.optimizeState = normalizeOptimizeState(isNamespacedData(raw) ? raw.optimize : undefined);

    // Any plaintext credential still in data.json moves to the secret store now,
    // then the file is rewritten without it. Must run after buildRuns is restored:
    // the persist below serializes them, and empty state here would wipe them.
    const store = this.secrets();
    const { moved, settings } = migrateSecrets(loaded, store);
    this.settings = hydrate(settings, store);
    if (moved.length > 0) {
      await this.persist();
      new Notice(migrationNotice(moved), 15000);
    }
  }

  /** Write settings + conversation history back to data.json, minus credentials. */
  async persist(): Promise<void> {
    const result = (this.persistChain ?? Promise.resolve()).catch(() => {}).then(async () => {
      const store = this.secrets();
      // Credentials the store proved it holds are dropped here; any the backend
      // silently refused stay in the file so they are not lost from both places.
      const stripped = stripVerifiedSecrets(this.settings, store);
      this.unverifiedSecrets = stripped.unverified;
      const data = JSON.parse(JSON.stringify({
        settings: stripped.settings,
        conversations: this.convState.conversations,
        activeConversationId: this.convState.activeId,
        ...this.orders().serializeState(),
        ...this.publishing().serializeState(),
        optimize: this.optimizeState,
        ...this.build().serializeState(),
      })) as PersistedData;
      await this.saveData(data);
    });
    this.persistChain = result.catch(() => {});
    await result;
  }

  async saveSettings(): Promise<void> {
    // Credentials go to the secret store first; persist() then strips them.
    syncSecrets(this.settings, this.secrets());
    await this.persist();
    // Rebuild providers if any credentials/hosts changed.
    this._router = null;
    // External MCP server list changed → drop stale sessions so they reconnect fresh.
    const serversJson = JSON.stringify(this.settings.mcpClientServers);
    if (this._mcpServersSnapshot !== serversJson) {
      this._mcpServersSnapshot = serversJson;
      if (this._externalMcp) void this._externalMcp.close();
    }
    this._semantic?.onSettingsChanged();
    this.refreshViews();
    await this.syncMcpServer();
    for (const listener of this.settingsListeners ?? []) listener();
  }

  // ---------- conversation history ----------

  /** Every chat project available in this vault (chat-project notes + Research Desk projects). */
  async listChatProjects(): Promise<ChatProject[]> {
    return listChatProjects(this.app, this.research().researchRepository());
  }

  /** The chat project a conversation is scoped to, or null when it has none. */
  async chatProjectFor(conversationId: string | null): Promise<ChatProject | null> {
    if (!conversationId) return null;
    const projectId = this.conversations().list().find((c) => c.id === conversationId)?.projectId ?? null;
    if (!projectId) return null;
    const projects = await this.listChatProjects();
    return projects.find((p) => p.id === projectId) ?? null;
  }

  async browseConversations(): Promise<void> {
    const view = await this.views().activateView();
    view?.openHistory();
  }

  async deleteActiveConversation(): Promise<void> {
    const active = this.conversations().getActive();
    if (!active) {
      new Notice("No active conversation to delete.");
      return;
    }
    await this.conversations().delete(active.id);
    const view = await this.views().activateView();
    if (!view) return;
    const next =this.conversations().getActive();
    if (next) view.loadConversation(next);
    else view.resetToEmpty();
    new Notice(`Deleted “${active.title}”.`);
  }

  // ---------- MCP bridge ----------

  syncMcpServer(): Promise<void> {
    return this.mcpBridge().sync();
  }

  private resolvedMcpToken(): string {
    return this.mcpBridge().resolvedToken();
  }

  mcpRunning(): boolean {
    return this.mcpBridge().running();
  }

  mcpStats(): { running: boolean; port: number | null; activeRequests: number; handledRequests: number } {
    return this.mcpBridge().stats();
  }

  async setMcpEnabled(enabled: boolean): Promise<void> {
    return this.mcpBridge().setEnabled(enabled);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof ChatView) {
        v.refreshModelLabel();
        void v.refreshBackendPill();
        void v.refreshContextStatus();
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_DESK_VIEW_TYPE)) if (leaf.view instanceof ResearchView) void leaf.view.render();
  }

  // ---------- providers ----------

  private chatCliProvider(): CliProvider {
    const router = this.router();
    switch (this.settings.chatBackend) {
      case "codex-cli": return router.codexCli;
      case "opencode-cli": return router.opencodeCli;
      default: return router.claudeCli;
    }
  }

  router(): ProviderRouter {
    if (this._router && !this._router.hasCurrentAnthropicEnvironment()) this._router = null;
    const runtime = this.cliRuntime();
    this._cliProvider ??= new CliProvider(claudeBackend, runtime, () => this.vaultBasePath());
    this._codexProvider ??= new CliProvider(codexBackend, runtime, () => this.vaultBasePath());
    this._opencodeProvider ??= new CliProvider(opencodeBackend, runtime, () => this.vaultBasePath());
    if (!this._router) {
      this._router = new ProviderRouter(this.settings, () => this.utilityRouting().resolveSession(), {
        cliRuntime: runtime,
        isMobile: Platform.isMobile,
        cliProvider: this._cliProvider,
        codexProvider: this._codexProvider,
        opencodeProvider: this._opencodeProvider,
        deviceProvider: new DeviceProvider(this.settings.chatBackend === "device" ? this.deviceChat() : null),
      });
    }
    return this._router;
  }

  private _deviceChat?: DeviceChatClient;
  deviceChatBusy(): boolean { return this._deviceChat?.busy() ?? false; }
  deviceChat(): DeviceChatClient {
    if (!this._deviceChat) {
      this._deviceChat = new DeviceChatClient(createEmbedWorker, () => {
        if (Platform.isMobile) this._semantic?.pauseForDeviceChat();
      });
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.hidden) this._deviceChat?.cancel();
      });
    }
    return this._deviceChat;
  }

  /** Lazy ontology registry; null while the feature is disabled. IO is wired here; logic is pure. */
  ontology(): OntologyRegistry | null {
    if (!this.settings.ontologyEnabled) return null;
    if (!this._ontology) {
      this._ontology = new OntologyRegistry({
        listSchemaNotes: async () => {
          const folder = normalizePath(this.settings.ontologyFolder);
          const out: Array<{ path: string; frontmatter?: Record<string, unknown> | undefined; body: string }> = [];
          for (const f of this.app.vault.getMarkdownFiles()) {
            if (f.path !== folder && !f.path.startsWith(`${folder}/`)) continue;
            const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
            out.push({ path: f.path, frontmatter: fm, body: await this.app.vault.cachedRead(f) });
          }
          return out;
        },
        parseYaml: (src) => parseYaml(src) as unknown,
      });
    }
    return this._ontology;
  }

  composeSystemPrompt(opts?: { agent?: boolean; plan?: boolean; project?: ChatProject | null; compact?: boolean }): string {
    let base = opts?.compact ? this.settings.systemPrompt : `${this.settings.systemPrompt}\n\n${DESIGN_SYSTEM_PROMPT}`;
    const digest = this.ontology()?.digest();
    if (digest) base = `${base}\n\n${digest}`;
    if (opts?.project) base = `${base}\n\n${projectSystemPrompt(opts.project)}`;
    if (opts?.agent) base = `${base}\n\n${AGENT_INSTRUCTION}`;
    if (opts?.agent && opts?.plan) base = `${base}\n\n${PLAN_MODE_INSTRUCTION}`;
    return base;
  }

  /** Vault tools for the in-chat agent loop, options refreshed from settings on every call. */
  agentTools(): VaultTools {
    const opts = vaultToolOptions(this, this.settings.agentAllowWrites, "companion");
    if (!this.agentVaultTools) this.agentVaultTools = new VaultTools(this.app, opts);
    else this.agentVaultTools.setOptions(opts);
    return this.agentVaultTools;
  }

  /** Desktop only: the Node ports shared by every CLI chat backend. Tests override this. */
  cliRuntime(): CliRuntime | null {
    if (this._cliRuntime !== undefined) return this._cliRuntime;
    if (Platform.isMobile || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
      this._cliRuntime = null;
      return null;
    }
    this._cliRuntime = createNodeCliRuntime();
    return this._cliRuntime;
  }

  private async createChatBridge(binding: { deps: InteractiveToolDeps; run: ToolRunKind; backend: CliBackend }): Promise<{ server: McpHttpServer; port: number; token: string }> {
    const { McpHttpServer } = await import("./mcp/server");
    const token = generateToken();
    const registry = bridgeTools(this.agentTools(), { run: binding.run, deps: binding.deps, permissionPrompt: binding.backend.supportsPermissionPrompt, unavailable: (name) => this.agentTools().unavailable(name) });
    const server = new McpHttpServer(
      {
        port: 0,
        token,
        serverInfo: { name: "obsidian-vault", version: this.manifest.version },
        resources: composeResourceProviders(
          substrateResourceProvider(this.app, { call: (n, a) => this.agentTools().call(n, a), memoryPath: () => this.memoryNotePath() }),
          vaultResourceProvider(this.app),
        ),
        prompts: catalogPromptProvider(() => this.promptTemplates()),
      },
      registry,
      (level, message) => { if (level === "error") console.error("[Claude Companion chat bridge]", message); },
      CLI_HIDDEN_TOOLS,
    );
    await server.start();
    const addr = server.address();
    if (!addr) {
      await server.stop();
      throw new Error("The chat bridge did not bind.");
    }
    return { server, port: addr.port, token };
  }

  /** The CLI backend the settings currently select for chat, defaulting to Claude Code for any non-CLI value. */
  private cliBackendFor(chatBackend: PluginSettings["chatBackend"]): CliBackend {
    if (chatBackend === "codex-cli") return codexBackend;
    if (chatBackend === "opencode-cli") return opencodeBackend;
    return claudeBackend;
  }

  async cliTurnRunner(opts: { conversationId: string; run: ToolRunKind; model: string; deps: InteractiveToolDeps; transcript: string; resumeSessionId?: string }): Promise<AgentTurnRunner> {
    const backend = this.cliBackendFor(this.settings.chatBackend);
    const cli = this.router().get(backend.id) as CliProvider;
    const executable = cli.executable();
    if (!executable) throw new Error(cli.probe() ? `${backend.label} is not signed in. ${backend.signInHint[0]!.toUpperCase()}${backend.signInHint.slice(1)} in a terminal.` : `${backend.label} not found.`);
    const runtime = this.cliRuntime();
    const cwd = this.vaultBasePath();
    if (!runtime || !cwd) throw new Error(`${backend.label} runs on desktop only.`);
    const vaultDefs = this.agentTools().definitions();
    const allowedTools = cliAllowedTools(vaultDefs, toolAccess(opts.run, vaultDefs));
    const signature = JSON.stringify({ run: opts.run, backend: backend.id, model: opts.model, allowedTools, writes: this.settings.agentAllowWrites });
    const open = () => this.openCliSession(opts, { backend, executable, runtime, cwd, allowedTools });
    return this.cliPool.acquire(opts.conversationId, signature, open, { fresh: !!opts.resumeSessionId });
  }

  /** A new CLI session with its own chat bridge and prompt file; on failure everything it opened is released. */
  private async openCliSession(
    opts: Parameters<ClaudeCompanionPlugin["cliTurnRunner"]>[0],
    { backend, executable, runtime, cwd, allowedTools }: { backend: CliBackend; executable: string; runtime: CliRuntime; cwd: string; allowedTools: string[] },
  ): Promise<PoolEntry<CliSession>> {
    const project = await this.chatProjectFor(opts.conversationId);
    const systemPrompt = this.composeSystemPrompt({ agent: true, plan: opts.run === "plan", project });
    const promptFile = backend.processModel === "persistent" ? await runtime.writeSystemPromptFile(systemPrompt) : "";
    let bridge: McpHttpServer | null = null;
    const release = async (): Promise<void> => {
      await bridge?.stop();
      if (promptFile) await runtime.removeFile(promptFile);
    };
    try {
      const started = await this.createChatBridge({ deps: opts.deps, run: opts.run, backend });
      bridge = started.server;
      const mcpConfig = mcpConfigJson(started.port, started.token);
      let session: CliSession;
      let sessionIdToPersist: string | undefined;
      if (backend.processModel === "persistent") {
        const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
        const argv = backend.buildArgv({
          model: opts.model,
          systemPromptFile: promptFile,
          mcpConfigJson: mcpConfig,
          allowedTools,
          maxTurns: this.settings.agentMaxIterations,
          cwd,
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : { sessionId }),
        });
        session = new CliSession({ backend, spawn: () => runtime.spawn(executable, argv, cwd), ...(opts.transcript ? { transcript: opts.transcript } : {}) });
        sessionIdToPersist = sessionId;
      } else {
        session = new CliSession({
          backend,
          spawnTurn: (argv, env) => runtime.spawn(executable, argv, cwd, env),
          argvTemplate: { model: opts.model, systemPromptFile: "", mcpConfigJson: mcpConfig, allowedTools, maxTurns: this.settings.agentMaxIterations, cwd },
          systemPromptText: systemPrompt,
          onSessionId: (id) => void this.setConversationCliSession(opts.conversationId, id),
          ...(opts.transcript ? { transcript: opts.transcript } : {}),
          ...(opts.resumeSessionId ? { initialSessionId: opts.resumeSessionId } : {}),
        });
      }
      if (sessionIdToPersist) await this.setConversationCliSession(opts.conversationId, sessionIdToPersist);
      return { session, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  invalidateCliSession(conversationId: string): void {
    this._cliPool?.invalidate(conversationId);
  }

  interruptCliTurn(conversationId: string): void {
    this._cliPool?.interrupt(conversationId);
  }

  async closeCliSessions(): Promise<void> {
    await this._cliPool?.closeAll();
  }

  async setConversationCliSession(conversationId: string, sessionId: string): Promise<void> {
    return this.conversations().setCliSession(conversationId, sessionId);
  }

  /**
   * Defuddle capture for chat's "Attach page content" affordance. Undefined in
   * headless/test environments (no DOMParser) — callers hide the offer then.
   * Every call is an explicit user action; nothing fetches automatically.
   */
  captureWebPage(): WebCapture | undefined {
    if (typeof DOMParser === "undefined") return undefined;
    return (url: string) =>
      captureWebSource(url, {
        fetchHtml: async (target) => {
          const response = await requestUrl({ url: target, method: "GET", throw: false });
          if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
          return response.text;
        },
        parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
      });
  }

  // ---------- standing orders ----------
  standingOrders(): OrdersController {
    return this.orders().standingOrders();
  }

  // ---------- prompt templates (user slash commands) ----------
  /** Load every prompt-template note in the templates folder (vault is the source of truth). */
  async promptTemplates(): Promise<PromptTemplate[]> {
    const folder = normalizePath(this.settings.templatesFolder).replace(/\/+$/, "");
    if (!folder) return [];
    const prefix = `${folder}/`;
    const out: PromptTemplate[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      try {
        const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) ?? {};
        const body = stripFrontmatter(await this.app.vault.cachedRead(f));
        const template = parseTemplateNote(f.path, f.basename, fm, body);
        if (template) out.push(template);
      } catch (e) {
        console.debug("Claude Companion: skipping unreadable template", f.path, e);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Scaffold a template note with the frontmatter schema and open it for editing. */
  async createPromptTemplate(): Promise<void> {
    const folder = normalizePath(this.settings.templatesFolder);
    await ensureVaultFolder(this.app, folder);
    let path = normalizePath(`${folder}/My template.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${folder}/My template ${i}.md`);
    }
    const file = await this.app.vault.create(path, TEMPLATE_SCAFFOLD);
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice("Template created — edit the prompt, then run it as /my-template in chat.");
  }

  /** Open an artifact per the user's setting: in-app fullscreen, or a browser. */
  openArtifact(html: string, title: string): void {
    this.openArtifactWith(html, title, this.settings.artifactOpenTarget);
  }

  /** Open an artifact with an explicit target (split-button dropdown). */
  openArtifactWith(html: string, title: string, target: ArtifactOpenTarget): void {
    if (target === "obsidian") {
      new ArtifactModal(this.app, html, title).open();
    } else {
      void openArtifactExternally(html, title, target);
    }
  }

  /** Absolute path of the current vault, or null if not a desktop file vault. */
  vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /** Optimize brain: tag merges, link weave, type weave. */
  optimize(): OptimizeFeature {
    return (this._optimize ??= buildOptimize(this, { state: { get: () => this.optimizeState, set: (next) => { this.optimizeState = next; } } }));
  }

  async loadedOntology(): Promise<OntologyRegistry | null> {
    return loadedOntology(this.ontology());
  }

  publish(): PublishController {
    return this.publishing().publish();
  }
}
