import { App, FileSystemAdapter, MarkdownView, Notice, parseYaml, Platform, Plugin, requestUrl, WorkspaceLeaf } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./view/ChatView";
import { MemoryView, MEMORY_VIEW_TYPE } from "./view/MemoryView";
import { InboxView, INBOX_VIEW_TYPE } from "./view/InboxView";
import { RelatedView, RELATED_VIEW_TYPE } from "./view/RelatedView";
import { ResearchWorkbenchView, RESEARCH_WORKBENCH_VIEW_TYPE, ProjectCreateModal, QUESTION_INSTRUCTION, type ResearchWorkbenchTab } from "./view/ResearchWorkbenchView";
import { ResearchDeskView, RESEARCH_DESK_VIEW_TYPE } from "./view/ResearchDeskView";
import { BuildView, BUILD_VIEW_TYPE } from "./view/BuildView";
import { SimilarBasesView, SIMILAR_BASES_VIEW_TYPE } from "./view/SimilarBasesView";
import { normalizeDeskPreferenceMap, type ResearchDeskPreferenceMap } from "./research/deskPreferences";
import { ResearchRepository } from "./research/repository";
import { createResearchRepository } from "./research/repositoryFactory";
import { ensureVaultFolder, writeOrReplaceFile } from "./vault/vaultFiles";
import { IntelligenceCoordinator } from "./research/intelligenceCoordinator";
import { DiscoveryCoordinator } from "./discovery/coordinator";
import { DraftCoordinator } from "./research/draftCoordinator";
import { RevisionCoordinator } from "./research/revisionCoordinator";
import { OpenAlexAdapter } from "./discovery/adapters/openAlex";
import { CrossrefAdapter } from "./discovery/adapters/crossref";
import { ArxivAdapter } from "./discovery/adapters/arxiv";
import { createObsidianDiscoveryHttp } from "./discovery/adapters/obsidianHttp";
import type { ZoteroLibrary } from "./discovery/adapters/zotero";
import { resolveModelId } from "./claude/models";
import { inferResearchProjectPath, isResearchProjectChange, projectPathForActivation } from "./research/workbenchRouting";
import { SessionPicker } from "./view/SessionPicker";
import { WorkflowPicker } from "./view/WorkflowPicker";
import { WORKFLOWS, type Workflow } from "./workflows/catalog";
import type { SessionMeta } from "./memory/sessions";
import { MemoryController } from "./memory/controller";
import { McpBridgeController } from "./mcp/bridgeController";
import { ClaudeCompanionSettingTab } from "./settings";
import { companionCommands, type CommandActions } from "./commands/definitions";
import { ProviderRouter, type ProviderSelection, type RuntimeUtilitySelection, type UtilityFallbackConsentContext } from "./providers/router";
import { sanitizeEndpointForDisplay, UtilityUnavailableError, type UtilityFallbackApproval } from "./providers/endpointPolicy";
import { ANTHROPIC_DEFAULT_BASE_URL } from "./providers/auth";
import { DEFAULT_SETTINGS, normalizeDiscoverySettings, type PluginSettings, type ArtifactOpenTarget } from "./types";
import { DESIGN_SYSTEM_PROMPT, PLANNING_INSTRUCTION } from "./artifacts/designSystem";
import { AGENT_INSTRUCTION, PLAN_MODE_INSTRUCTION } from "./agent/prompt";
import { findUnlinkedMentions, linkMention, type LinkCandidate } from "./links/unlinkedMentions";
import { mentionEdits } from "./links/suggest";
import { planEdits, applyPlan, diffToEdits, type EditPlan } from "./edit/diff";
import { inlineDiffExtension, reviewInline } from "./editor/inlineDiffExtension";
import { selectionActionExtension } from "./editor/selectionAction";
import { editorViewOf } from "./editor/reviewEdits";
import { createRangeSession } from "./editor/inlineDiffState";
import { REWRITE_SYSTEM, buildRewriteUser, buildGroundedRewriteUser, rewriteMaxTokens, parseRewrite } from "./edit/rewrite";
import { DiffModal } from "./view/DiffModal";
import { BatchDiffModal } from "./view/BatchDiffModal";
import { RewriteModal } from "./view/RewriteModal";
import { renderArtifactInline, ArtifactModal, openArtifactExternally } from "./artifacts/renderInline";
import type { McpHttpServer } from "./mcp/server";
import { VaultTools, SEMANTIC_OFF_MESSAGE, type VaultToolsOptions } from "./mcp/vaultTools";
import { catalogPromptProvider, composeResourceProviders, substrateResourceProvider, vaultResourceProvider } from "./mcp/providers";
import { MEMORY_NOTE_BASENAME } from "./memory/consolidate";
import { ExternalMcpManager } from "./mcp/externalManager";
import { externalAnthropicTools } from "./mcp/external";
import type { AnthropicToolDef, ProviderId } from "./providers/types";
import { braveSearch, duckDuckGoSearch, formatSearchResults } from "./web/search";
import { webFetch as webFetchPage } from "./web/fetch";
import { parseTemplateNote, TEMPLATE_SCAFFOLD, type PromptTemplate } from "./templates/promptTemplates";
import { buildOrganizePrompt, buildFolderOrganizePrompt, parseOrganizeResponse, planOrganizeMoves, type OrganizeCandidate } from "./sources/organize";
import { LINT_SYSTEM, buildLintUser, lintMaxTokens, parseLintResponse } from "./enrich/noteEnrich";
import { EnrichOptionsModal, EnrichReviewModal, type EnrichDecision, type EnrichOptions, type EnrichProposal } from "./view/EnrichModal";
import { sanitizeFileName } from "./artifacts/parse";
import { OrganizeReviewModal } from "./view/OrganizeReviewModal";
import { stripFrontmatter } from "./semantic/chunk";
import { generateToken } from "./mcp/clientConfig";
import type { AgentTurnRunner } from "./agent/loop";
import { ClaudeCliSession } from "./cli/session";
import { buildClaudeArgv, mcpConfigJson } from "./cli/argv";
import { CLI_HIDDEN_TOOLS, cliAllowedTools, interactiveTools, type InteractiveToolDeps } from "./cli/bridgeTools";
import { createNodeCliRuntime, type ClaudeCliRuntime } from "./cli/runtime";
import { ClaudeCliProvider } from "./providers/claudeCli";
import { type BuildRun } from "./build/run";
import { BuildController } from "./build/controller";
import { CloudController } from "./cloud/controller";
import { CloudDispatchModal } from "./view/CloudDispatchModal";
import { normalizeTags } from "./indexing/frontmatter";
import { existingVaultTags } from "./indexing/autoTagger";
import { frontmatterSuggestSystem, parseFrontmatterSuggestion } from "./indexing/frontmatterSuggest";
import { FrontmatterModal } from "./view/FrontmatterModal";
import { SemanticIndexer } from "./semantic/indexer";
import { SemanticController } from "./semantic/controller";
import { isNamespacedData, resolveSettings } from "./settingsLoad";
import { createSecretStore, hydrate, stripVerifiedSecrets, syncSecrets, type SecretField, type SecretStore } from "./secrets/store";
import { migrateSecrets, migrationNotice } from "./secrets/migrate";
import { needsCredentialSetup } from "./providers/setupState";
import { pendingFirstRunPrompts, type FirstRunState } from "./onboarding/firstRun";
import type { TransformersEmbedder } from "./semantic/transformers/embedder";
import { builtinModelById } from "./semantic/transformers/model";
import {
  type Conversation,
  type ConversationState,
  emptyState,
  fromPersisted,
  cliSessionIds,
  type ChatTurnMode,
} from "./conversations/store";
import { ConversationsController } from "./conversations/controller";
import type { ChatMessage } from "./types";
import { normalizePath, TFile, TFolder, type Editor } from "obsidian";
import { inboxItems } from "./sources/inbox";
import { parseClipUrl } from "./sources/detect";
import { SourceEnrichmentController, sourceActivityDetail, type EnrichRunOutcome } from "./sources/controller";
import { getSchema } from "./sources/registry";
import { clipperTemplateFor, clipperTemplateFileName, serializeClipperTemplate, clipperFingerprint } from "./sources/clipperTemplate";
import type { SourceType } from "./sources/types";
import { errorHint } from "./providers/errorHints";
import { ChoiceModal } from "./view/ChoiceModal";
import { OntologyRegistry } from "./ontology/registry";
import { seedFiles } from "./ontology/seed";
import { auditProject } from "./research/audit";
import { buildResearchDeskViewModel } from "./research/deskViewModel";
import { TRIAGE_SYSTEM, buildTriageUser, parseTriageResponse, renderTriageNote, themeTagSlug, noteExcerpt, type TriageNote } from "./research/triage";
import { captureWebSource } from "./research/webCapture";
import type { WebCapture } from "./context/webCapture";
import { summarizeAndTag } from "./indexing/autoTagger";
import { resolveCompanionWorkspace, type CompanionWorkspaceCard } from "./view/companionWorkspace";
import type { BatchLinkApplyResult } from "./links/batch";
import { reviewInboxBatchLinks } from "./links/inboxBatchReview";
import { ActivityStore } from "./activity/store";
import type { CompanionChromeDependencies } from "./view/companionChrome";
import type { QuickOptionAction, QuickOptionChange, QuickOptionsState } from "./view/quickOptions";
import type { EmbeddingRecovery } from "./semantic/recovery";
import { clipperSetupFor, type ClipperSetupViewModel } from "./sources/clipperSetup";
import { verifyClipperNote } from "./sources/clipperVerification";
import { EnrichDiagnostics } from "./sources/enrichDiagnostics";
import { ClipperSetupModal } from "./view/ClipperSetupModal";
import { DesktopIntegrationCoordinator, type DesktopIntegrationRuntime } from "./integrations/desktopCoordinator";
import { DesktopIntegrationsModal, type DesktopIntegrationsController } from "./view/DesktopIntegrationsModal";
import { ConfirmModal } from "./view/ConfirmModal";
import { OBSIDIAN_GENERAL_SETTINGS_TAB, claudeDesktopConfigPath, type DesktopPlatform } from "./integrations/desktop";

/** Output-token ceiling for artifact-producing flows (plans, artifacts, workflows),
 *  which routinely run past the chat default. A ceiling, not a target — you only
 *  pay for what's generated. Within current models' max-output limits. */
// Artifacts/plans are long (rich layout + inline script); give generous output
// headroom so a tabbed document finishes instead of truncating into broken JS.
const ARTIFACT_MAX_TOKENS = 32000;
/**
 * Mobile's native vault bridge expands a full-file read/write into several
 * Java and JS copies. A larger note can exceed Android's renderer heap even
 * though extraction sends only the first 8,000 characters to the model.
 */
const MOBILE_SOURCE_NOTE_MAX_BYTES = 5 * 1024 * 1024;
/** PDFs expand substantially during parsing; reject large mobile semantic
 * inputs before the native vault bridge creates its first binary copy. */
const MOBILE_SEMANTIC_PDF_MAX_BYTES = 10 * 1024 * 1024;

/** Shape of this plugin's persisted data.json (settings + chat history). */
interface PersistedData {
  settings?: Partial<PluginSettings>;
  conversations?: Conversation[];
  activeConversationId?: string | null;
  researchDeskPreferences?: ResearchDeskPreferenceMap;
  buildRuns?: BuildRun[];
  activeBuildRunId?: string | null;
}

type UtilityFallbackConsentKey = Pick<UtilityFallbackConsentContext, "identity" | "destinationFingerprint">;

function sameUtilityFallbackConsentContext(
  left: UtilityFallbackConsentKey,
  right: UtilityFallbackConsentKey | null | undefined,
): boolean {
  return !!right && left.identity === right.identity && left.destinationFingerprint === right.destinationFingerprint;
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
  private _conversations?: ConversationsController;
  private conversations(): ConversationsController {
    return (this._conversations ??= new ConversationsController({
      state: { get: () => this.convState, set: (next) => { this.convState = next; } },
      persist: () => this.persist(),
      activity: () => this.activity,
      settings: () => this.settings,
    }));
  }
  private researchDeskPreferences: ResearchDeskPreferenceMap = {};
  private _build: BuildController | null = null;
  private build(): BuildController {
    return (this._build ??= new BuildController({
      settings: () => this.settings,
      persist: () => this.persist(),
      isMobile: Platform.isMobile,
      vault: {
        cachedRead: (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          return file instanceof TFile ? this.app.vault.cachedRead(file) : Promise.reject(new Error(`File not found: ${path}`));
        },
        processFile: async (path, fn) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) await this.app.vault.process(file, fn);
        },
      },
      writeFile: async (path, content) => { await writeOrReplaceFile(this.app, path, content); },
      ensureFolder: (folder) => ensureVaultFolder(this.app, folder),
      openFile: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      },
      normalizePath,
      notice: (msg, timeout) => new Notice(msg, timeout),
      confirm: (opts) => new Promise<boolean>((resolve) => {
        new ConfirmModal(this.app, { ...opts, onResolve: resolve }).open();
      }),
      cloud: () => this.cloud(),
      vaultBasePath: () => this.vaultBasePath(),
      desktopProcess: () => (window as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process,
      desktopRuntimeLoader: () => this._desktopRuntimeLoader(),
    }));
  }
  /** data.json contains several domains; serialize snapshots so an older write cannot land last. */
  private persistChain: Promise<void> = Promise.resolve();
  /** Credentials live here, not in data.json. Lazy so tests can construct the plugin. */
  private _secrets: SecretStore | null = null;
  /** Set by the last persist: credentials the store refused, still in data.json. */
  private unverifiedSecrets: SecretField[] = [];
  private _router: ProviderRouter | null = null;
  /** Owns the sign-in probe across router rebuilds (settings saves null the router). */
  private _cliProvider: ClaudeCliProvider | null = null;
  private _intelligenceCoordinator: IntelligenceCoordinator | null = null;
  private _discoveryCoordinator: DiscoveryCoordinator | null = null;
  private _viewIntelligenceCoordinators?: Set<IntelligenceCoordinator>;
  private _viewDiscoveryCoordinators?: Set<DiscoveryCoordinator>;
  private cliSessions = new Map<string, { session: ClaudeCliSession; bridge: McpHttpServer; signature: string; promptFile: string; lastUsed: number }>();
  private cliPromptFiles = new Set<string>();
  private _cliRuntime: ClaudeCliRuntime | null | undefined;
  private _desktopIntegrationModals?: Set<DesktopIntegrationsModal>;
  private _desktopRuntimeLoader: () => Promise<{
    createNodeDesktopRuntime(platform: DesktopPlatform, homeDir: string, env: Record<string, string | undefined>): Promise<DesktopIntegrationRuntime>;
    createNodeManagedProcessPort(): import("./build/desktopExecutor").ManagedProcessPort;
  }> = () => import("./integrations/desktopRuntime");
  private _externalMcp: ExternalMcpManager | null = null;
  private _mcpServersSnapshot = "[]";
  /** Chat-scoped vault tools (agent mode) — separate instance and write gate from the MCP bridge. */
  private agentVaultTools: VaultTools | null = null;
  private mcpLifecycleGeneration = 0;
  private mcpLifecycleEnded = false;
  private _mcpBridge: McpBridgeController | null = null;
  private memoryNotePath(): string {
    return normalizePath(`${this.settings.memoryFolder}/${MEMORY_NOTE_BASENAME}.md`);
  }
  private mcpBridge(): McpBridgeController {
    return (this._mcpBridge ??= new McpBridgeController({
      settings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      isMobile: Platform.isMobile,
      isLifecycleEnded: () => this.mcpLifecycleEnded,
      lifecycleGeneration: () => this.mcpLifecycleGeneration ?? 0,
      buildToolOptions: () => ({
        allowWrites: this.settings.mcpAllowWrites,
        defaultFolder: this.settings.mcpWriteFolder,
        semantic: (q: string, k: number, accept?: (path: string) => boolean) => this.semanticSearch(q, k, accept),
        related: async (p: string, k: number) => {
          if (!this.settings.semanticEnabled) throw new Error(SEMANTIC_OFF_MESSAGE);
          return this.relatedForTools(p, k);
        },
        ontology: () => this.ontology(),
        ontologyFolder: () => this.settings.ontologyFolder,
        zotero: () => this.zoteroLibrary(),
        ...this.webToolImpls(),
      }),
      createTools: (opts) => new VaultTools(this.app, opts),
      createServer: async (tools, port, token) => {
        const { McpHttpServer } = await import("./mcp/server");
        return new McpHttpServer(
          {
            port,
            token,
            serverInfo: { name: "obsidian-vault", version: "0.2.0" },
            resources: composeResourceProviders(
              substrateResourceProvider(this.app, { call: (n, a) => (tools as unknown as VaultTools).call(n, a), memoryPath: () => this.memoryNotePath() }),
              vaultResourceProvider(this.app),
            ),
            prompts: catalogPromptProvider(() => this.promptTemplates()),
          },
          tools as unknown as VaultTools,
          (level, message) => { if (level === "error") console.error("[Claude Companion MCP]", message); },
        );
      },
      notice: (msg) => new Notice(msg),
    }));
  }
  private _semantic: SemanticController | null = null;
  private semantic(): SemanticController {
    return (this._semantic ??= new SemanticController({
      settings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      manifestDir: this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
      manifestId: this.manifest.id,
      activity: () => this.activity,
      enrichDiagnostics: () => this.enrichDiagnostics,
      router: () => this.router(),
      isMobile: Platform.isMobile,
      vault: {
        adapterExists: (p) => this.app.vault.adapter.exists(p),
        adapterRead: (p) => this.app.vault.adapter.read(p),
        adapterWrite: (p, d) => this.app.vault.adapter.write(p, d),
        getMarkdownFiles: () => this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
        getPdfFiles: () => this.app.vault.getFiles().filter((f) => f.extension === "pdf").map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
        getAbstractFileByPath: (p) => {
          const f = this.app.vault.getAbstractFileByPath(p);
          return f instanceof TFile ? { path: f.path, stat: { mtime: f.stat.mtime, size: f.stat.size } } : null;
        },
        cachedRead: (p) => {
          const f = this.app.vault.getAbstractFileByPath(p);
          return f instanceof TFile ? this.app.vault.cachedRead(f) : Promise.resolve("");
        },
        readBinary: (p) => {
          const f = this.app.vault.getAbstractFileByPath(p);
          if (!(f instanceof TFile)) return Promise.reject(new Error(`Not a file: ${p}`));
          return this.app.vault.readBinary(f);
        },
      },
      notice: (msg, timeout) => new Notice(msg, timeout),
      openChoiceModal: (opts) => new ChoiceModal(this.app, opts).open(),
      mobileSourceNoteMaxBytes: MOBILE_SOURCE_NOTE_MAX_BYTES,
      mobilePdfMaxBytes: MOBILE_SEMANTIC_PDF_MAX_BYTES,
    }));
  }
  private _enrichment: SourceEnrichmentController | null = null;
  private enrichment(): SourceEnrichmentController {
    return (this._enrichment ??= new SourceEnrichmentController({
      settings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      isMobile: Platform.isMobile,
      mobileSourceNoteMaxBytes: MOBILE_SOURCE_NOTE_MAX_BYTES,
      enrichApp: this.app,
      vault: {
        cachedRead: (path) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          return f instanceof TFile ? this.app.vault.cachedRead(f) : Promise.resolve("");
        },
      },
      activity: () => this.activity,
      enrichDiagnostics: () => this.enrichDiagnostics,
      router: () => this.router(),
      suspendReindex: () => this.suspendReindex(),
      isUtilityLifecycleActive: (g) => this.isUtilityLifecycleActive(g),
      assertUtilityLifecycleActive: (g) => this.assertUtilityLifecycleActive(g),
      utilityLifecycleEnded: () => this.utilityLifecycleEnded,
      utilityLifecycleGeneration: () => this.utilityLifecycleGeneration ?? 0,
      notice: (msg, timeout) => new Notice(msg, timeout),
      openChoiceModal: (opts) => { const m = new ChoiceModal(this.app, opts); m.open(); return m; },
    }));
  }
  private _memory: MemoryController | null = null;
  memory(): MemoryController {
    return (this._memory ??= new MemoryController({
      settings: () => this.settings,
      isMobile: Platform.isMobile,
      ingestApp: this.app,
      vaultBasePath: () => this.vaultBasePath(),
      vault: {
        markdownFilesUnder: (prefix) => this.app.vault.getMarkdownFiles()
          .filter((f) => f.path.startsWith(`${prefix}/`))
          .map((f) => ({ path: f.path, mtime: f.stat.mtime })),
        readContent: async (path) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          return f instanceof TFile ? this.app.vault.cachedRead(f) : null;
        },
        writeContent: async (path, content) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (f instanceof TFile) await this.app.vault.modify(f, content);
          else await this.app.vault.create(path, content);
        },
      },
      router: () => this.router(),
      excludedSessionIds: () => this.conversations().list().flatMap(cliSessionIds),
      getActiveConversation: () => this.getActiveConversation(),
      nodeSessionReader: async () => {
        const { nodeSessionReader, defaultProjectsRoot } = await import("./memory/nodeReader");
        return { reader: nodeSessionReader, defaultProjectsRoot };
      },
      notice: (msg, timeout) => new Notice(msg, timeout),
      refreshMemoryView: () => this.refreshMemoryView(),
      openFile: async (path) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
      },
      openSessionPicker: (sessions, onPick) => new SessionPicker(this.app, sessions, onPick).open(),
      normalizePath,
    }));
  }
  private clipperVerificationTimers = new Map<string, number>();
  private utilityLifecycleEnded = false;
  private utilityLifecycleGeneration = 0;
  /** Mobile loopback → Claude consent, scoped to one exact source/destination context. */
  private mobileUtilityFallbackApproval: UtilityFallbackConsentKey & { decision: UtilityFallbackApproval } | undefined;
  /** Coalesces concurrent automatic enrichments onto one consent decision. */
  private mobileUtilityFallbackConsentInFlight: UtilityFallbackConsentKey & { promise: Promise<UtilityFallbackApproval> } | null = null;
  /** Active fallback disclosure, closed fail-safe when the plugin unloads. */
  private mobileUtilityFallbackModal: ChoiceModal<UtilityFallbackApproval> | null = null;
  /** Source-inbox ribbon icon + its pending-count badge (debounced). */
  private inboxRibbonEl: HTMLElement | null = null;
  private inboxBadgeTimer: number | null = null;
  /** Lazily-built ontology registry; null while the feature is disabled. */
  private _ontology: OntologyRegistry | null = null;
  /** Debounce timer for ontology reloads on schema-note changes. */
  private _ontologyReloadTimer: number | null = null;
  /** Debounces research-only metadata changes without reacting to unrelated vault notes. */
  private researchRefreshTimer: number | null = null;
  private researchRefreshChanges: Array<{ path: string; oldPath?: string }> = [];
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
    this.utilityLifecycleGeneration = (this.utilityLifecycleGeneration ?? 0) + 1;
    this.utilityLifecycleEnded = false;
    this._enrichment?.resetLifecycle();
    this.mobileUtilityFallbackApproval = undefined;
    this.mobileUtilityFallbackConsentInFlight = null;
    this.mobileUtilityFallbackModal = null;
    await this.loadSettings();

    this.registerViews();

    this.registerArtifactBlocks();

    this.registerEditorExtension(inlineDiffExtension());
    if (Platform.isDesktop) {
      this.registerEditorExtension(
        selectionActionExtension({
          enabled: () => this.settings.selectionActionEnabled,
          run: () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) void this.runInlineRewrite(view.editor, view);
          },
        }),
      );
    }

    // One ribbon icon for the plugin itself. Workflows and session capture live
    // in the chat panel's header action bar, so they don't need ribbon entries.
    this.addRibbonIcon("sparkles", "Open Companion for Claude", () => void this.activateView());
    this.inboxRibbonEl = this.addRibbonIcon("inbox", "Source inbox", () => void this.activateInboxView());
    this.inboxRibbonEl.addClass("cc-inbox-ribbon");

    this.registerContextMenus();
    for (const command of companionCommands(this.commandActions())) this.addCommand(command);

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
    this.registerView(RELATED_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RelatedView(leaf, this));
    this.registerView(BUILD_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BuildView(leaf, this.build().viewDependencies()));
    this.registerView(RESEARCH_DESK_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ResearchDeskView(leaf, this.researchRepository(), {
      chrome: this.companionChrome(),
      preferencesFor: (projectPath) => this.researchDeskPreferences[projectPath] ?? { dismissedActionIds: [] },
      updatePreferences: async (projectPath, update) => { this.researchDeskPreferences[projectPath] = update(this.researchDeskPreferences[projectPath] ?? { dismissedActionIds: [] }); await this.persist(); },
      openWorkbench: (projectPath, target, path) => this.activateResearchWorkbench(projectPath, target, path),
      askCompanion: (projectPath) => this.askCompanionAboutProject(projectPath),
      createProject: () => this.activateResearchWorkbench(undefined, "Overview"),
      triageClippings: () => this.triageClippings(),
      startFromActiveNote: () => void this.startResearchFromActiveNote(),
    }));
    this.registerView(RESEARCH_WORKBENCH_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ResearchWorkbenchView(
      leaf,
      this.researchRepository(),
      (() => {
        const discoveryCoordinator = this.createDiscoveryCoordinator();
        const coordinator = this.createIntelligenceCoordinator();
        return {
          chrome: this.companionChrome(),
          coordinator,
          narratorMode: () => this.settings.intelligenceNarrator,
          retainIntelligenceCoordinator: () => this.retainIntelligenceCoordinator(coordinator),
          releaseIntelligenceCoordinator: () => this.releaseIntelligenceCoordinator(coordinator),
          discoveryCoordinator,
          retainDiscoveryCoordinator: () => this.retainDiscoveryCoordinator(discoveryCoordinator),
          releaseDiscoveryCoordinator: () => this.releaseDiscoveryCoordinator(discoveryCoordinator),
          draftCoordinator: new DraftCoordinator({ selection: () => this.router().chatProvider(), maxTokens: () => this.settings.maxTokens }),
          revisionCoordinator: new RevisionCoordinator({ selection: () => this.router().chatProvider(), maxTokens: () => this.settings.maxTokens }),
          rewriteText: this.researchRewriteText(),
          ...(typeof DOMParser === "undefined" ? {} : {
            captureWeb: (url: string) => captureWebSource(url, {
              fetchHtml: async (target) => {
                const response = await requestUrl({ url: target, method: "GET", throw: false });
                if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
                return response.text;
              },
              parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
            }),
          }),
          saveAsset: async (projectPath, name, data) => {
            const folder = `${projectPath.slice(0, -"/Project.md".length)}/Sources/assets`;
            await ensureVaultFolder(this.app, folder);
            let path = normalizePath(`${folder}/${name}`);
            if (this.app.vault.getAbstractFileByPath(path)) {
              const base = name.replace(/\.[^.]+$/, "");
              const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
              path = normalizePath(`${folder}/${base}-${Date.now()}${ext}`);
            }
            await this.app.vault.createBinary(path, data);
            return path;
          },
          suggestTags: async (content) => {
            try {
              const { tags } = await summarizeAndTag(this.router(), content, existingVaultTags(this.app));
              return tags;
            } catch (e) {
              console.warn("[companion] source tagging failed", e);
              return [];
            }
          },
          openDesk: (projectPath) => this.activateResearchDesk(projectPath),
          askCompanion: (projectPath) => this.askCompanionAboutProject(projectPath),
        };
      })(),
    ));
    this.registerBasesView(SIMILAR_BASES_VIEW_TYPE, {
      name: "Similar notes",
      icon: "sparkles",
      factory: (controller, containerEl) => new SimilarBasesView(controller, containerEl, {
        semanticEnabled: () => this.settings.semanticEnabled,
        related: (path, k, accept) => this.relatedForTools(path, k, accept),
      }),
      options: () => [{ type: "slider", key: "limit", displayName: "Results", min: 5, max: 50, step: 1, default: 20 }],
    });
  }

  /** Inline interactive artifacts, rendered from claude-html fences. */
  private registerArtifactBlocks(): void {
    // Inline interactive artifacts: ```claude-html ... ```
    this.registerMarkdownCodeBlockProcessor("claude-html", (source, el, ctx) => {
      let height = this.settings.artifactHeight;
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
      });
    });
  }

  /**
   * Work deferred to layout-ready. Vault listeners register here so Obsidian's
   * initial scan does not fire create/modify for every note and stampede them.
   */
  private startAfterLayout(): void {
    if (!Platform.isMobile) void this.router().claudeCli.refresh().then(() => this.refreshViews());
      void this.syncMcpServer();
      this.syncPlanBuildActions();
      void this.runFirstRun();
      // Schemas/inbox changed since the clipper templates were exported →
      // the clipper is clipping against a stale schema. Offer once per session.
      if (this.settings.sourceCaptureEnabled && this.clipperTemplatesStale()) {
        new Notice("Source schemas changed since your Web Clipper templates were exported — re-export from Settings → Source capture.", 9000);
      }

      // Keep the semantic index fresh as notes change (debounced; no-op when
      // off). Registered AFTER layout-ready so Obsidian's initial vault scan
      // doesn't fire create/modify for every note and stampede the indexer —
      // a full build only happens via the explicit "Rebuild" command.
      this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile && (f.extension === "md" || (f.extension === "pdf" && this.settings.semanticIndexPdfs))) this.queueReindex(f.path); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile && (f.extension === "md" || (f.extension === "pdf" && this.settings.semanticIndexPdfs))) this.queueReindex(f.path); }));
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof TFile && (f.extension === "md" || f.extension === "csv") && this.settings.sourceCaptureEnabled && this.settings.sourceEnrichOnCreate) this.enrichment().queueEnrich(f);
      }));
      this.registerEvent(this.app.vault.on("create", (f) => {
        if (f instanceof TFile && f.extension === "md") this.queueClipperVerification(f);
      }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile && (f.extension === "md" || f.extension === "pdf")) void this.indexer()?.removeNote(f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f instanceof TFile && (f.extension === "md" || f.extension === "pdf")) void this.indexer()?.renameNote(oldPath, f.path); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f.path.endsWith(".md")) this.scheduleResearchRefresh(f.path); }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f.path.endsWith(".md")) this.scheduleResearchRefresh(f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f.path.endsWith(".md") || oldPath.endsWith(".md")) this.scheduleResearchRefresh(f.path, oldPath); }));

      // Inbox ribbon badge: pending count, refreshed on vault + frontmatter
      // changes (debounced — enrichment stamps source_enriched via frontmatter).
      this.syncInboxBadge();
      this.registerEvent(this.app.vault.on("create", () => this.scheduleInboxBadgeSync()));
      this.registerEvent(this.app.vault.on("delete", () => this.scheduleInboxBadgeSync()));
      this.registerEvent(this.app.vault.on("rename", () => this.scheduleInboxBadgeSync()));
      this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleInboxBadgeSync()));

      // Reload the ontology when schema notes under the ontology folder change
      // (debounced; no-op while the feature is off).
      const inOntology = (path: string): boolean => path.startsWith(`${normalizePath(this.settings.ontologyFolder)}/`);
      this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && inOntology(f.path)) this.scheduleOntologyReload(); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && inOntology(f.path)) this.scheduleOntologyReload(); }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && inOntology(f.path)) this.scheduleOntologyReload(); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f instanceof TFile && f.extension === "md" && this.settings.ontologyEnabled && (inOntology(f.path) || inOntology(oldPath))) this.scheduleOntologyReload(); }));
  }

  /** Keeps the plan Build action and the last-seen note in step with the workspace. */
  private registerNoteTracking(): void {
    // Show a "Build" action in the header of any `type: plan` note.
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncPlanBuildActions()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncPlanBuildActions()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (file) this.lastMarkdownFile = file;
    }));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.syncPlanBuildActions()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.scheduleResearchRefresh(file.path);
    }));
  }

  /** Right-click entries that mirror commands, on a selection and in the file explorer. */
  private registerContextMenus(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView) || editor.getSelection().trim().length === 0) return;
        menu.addItem((item) =>
          item
            .setTitle("Rewrite with Claude…")
            .setIcon("sparkles")
            .onClick(() => void this.runInlineRewrite(editor, view)),
        );
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Enrich with Claude…")
              .setIcon("sparkles")
              .onClick(() => void this.enrichNoteFlow(file)),
          );
        } else if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle("Enrich notes with Claude…")
              .setIcon("sparkles")
              .onClick(() => void this.enrichFolderFlow(file)),
          );
          menu.addItem((item) =>
            item
              .setTitle("Organize notes into subfolders…")
              .setIcon("folder-tree")
              .onClick(() => void this.organizeFolderFlow(file)),
          );
        }
      }),
    );
  }

  /** Everything `companionCommands` needs, so the definitions stay free of the plugin. */
  private commandActions(): CommandActions {
    return {
      activeMarkdownFile: () => this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null,
      lastMarkdownFile: () => this.lastMarkdownFile ?? null,
      hasActiveConversation: () => !!this.getActiveConversation(),
      sourceCaptureEnabled: () => this.settings.sourceCaptureEnabled,
      ontologyEnabled: () => this.settings.ontologyEnabled,
      desktop: !Platform.isMobile,

      openChat: () => void this.activateView(),
      newChat: () => void this.activateView().then((view) => view?.clearChat()),
      generatePlanFromNote: () => void this.generatePlanFromNote(),
      generateArtifactFromContext: () => void this.generateArtifactFromContext(),
      rewriteSelection: (editor, view) => void this.runInlineRewrite(editor, view),
      enrichNote: (file) => void this.enrichNoteFlow(file),
      enableVaultSearch: () => void this.enableVaultSearch(),
      rebuildSemanticIndex: () => void this.rebuildSemanticIndex(),
      openRelatedNotes: () => void this.activateRelatedView(),
      openResearchDesk: () => void this.activateResearchDesk(),
      openResearchWorkbench: () => void this.activateResearchWorkbench(),
      triageClippings: () => void this.triageClippings(),
      startResearchFromActiveNote: () => void this.startResearchFromActiveNote(),
      showSemanticIndexStatus: () => void this.showSemanticIndexStatus(),
      browseConversations: () => void this.browseConversations(),
      deleteActiveConversation: () => void this.deleteActiveConversation(),
      handoffToBuild: () => void this.handoffToBuild(),
      markNoteAsPlan: (file) => void this.markNoteAsPlan(file),
      organizeClippings: () => void this.organizeClippings(),
      dispatchCloudSession: () => void this.dispatchCloudSession(),
      pullCloudReplies: () => void this.pullCloudReplies(),
      reviewLinkSuggestions: () => void this.reviewLinkSuggestions(),
      openWorkflowPicker: () => void this.openWorkflowPicker(),
      createPromptTemplate: () => void this.createPromptTemplate(),
      openSessionPicker: () => void this.memory().openSessionPicker(),
      openMemoryView: () => void this.activateMemoryView(),
      consolidateMemory: () => void this.memory().consolidateMemory(),
      enrichNoteAsSource: (file) => void this.enrichment().runEnrich(file),
      openSourceInbox: () => void this.activateInboxView(),
      exportClipperTemplates: () => void this.exportClipperTemplates(),
      seedOntology: () => void this.seedOntology(),
    };
  }

  /** Turn vault search on and tell the user which engine answers. */
  private async enableVaultSearch(): Promise<void> {
    this.settings.context.searchVault = true;
    await this.saveSettings();
    const view = await this.activateView();
    view?.refreshModelLabel();
    const how = this.settings.semanticEnabled ? "semantic + keyword" : "keyword";
    new Notice(`Vault search is on (${how}) — ask your question in the chat panel.`);
  }

  /** Plugin-owned runtime/privacy hook used by every router utility completion. */
  private async resolveUtilitySelectionForSession(): Promise<ProviderSelection> {
    if (this.utilityLifecycleEnded) throw new Error("Companion unloaded before utility approval completed; no content was sent.");
    let selection = this.runtimeUtilitySelection();
    if (selection.state === "unavailable-loopback") {
      const promptedContext = this.router().utilityFallbackConsentContext(Platform.isMobile);
      if (!promptedContext) throw new UtilityUnavailableError(this.utilityUnavailableMessage(selection), selection);
      const approval = await this.mobileUtilityFallbackConsent(promptedContext);
      if (this.utilityLifecycleEnded) throw new Error("Companion unloaded before utility approval completed; no content was sent.");

      // Settings may rebuild the router while the modal is open. Reacquire it,
      // inspect the full current source + destination identity, and never apply
      // consent obtained for a different gateway or auth context.
      const currentRouter = this.router();
      const current = currentRouter.resolveUtilityForRuntime({ isMobile: Platform.isMobile });
      const currentContext = currentRouter.utilityFallbackConsentContext(Platform.isMobile);
      if (!sameUtilityFallbackConsentContext(promptedContext, currentContext)) {
        if (sameUtilityFallbackConsentContext(promptedContext, this.mobileUtilityFallbackApproval)) {
          this.mobileUtilityFallbackApproval = undefined;
        }
        if (current.state === "unavailable-loopback" || current.state === "unavailable-without-Claude") {
          if (current.state === "unavailable-loopback" && currentContext) {
            throw new Error(
              `The utility destination changed while fallback approval was open. ` +
              `The current Anthropic fallback endpoint is ${currentContext.fallbackEndpoint}. Retry the utility action to review the current destination.`,
            );
          }
          throw new UtilityUnavailableError(this.utilityUnavailableMessage(current), current);
        }
        throw new Error(
          `Utility settings changed while Claude fallback approval was open. ` +
          `The current ${current.backend} utility backend is ${current.endpoint ?? current.provider.label}. Retry the utility action to use the current settings.`,
        );
      }
      selection = currentRouter.resolveUtilityForRuntime({
        isMobile: Platform.isMobile,
        fallbackApproval: approval,
      });
    }
    if (selection.state === "configured-provider" || selection.state === "approved-Claude-fallback") {
      return selection;
    }
    throw new UtilityUnavailableError(this.utilityUnavailableMessage(selection), selection);
  }

  private mobileUtilityFallbackConsent(context: UtilityFallbackConsentContext): Promise<UtilityFallbackApproval> {
    if (this.utilityLifecycleEnded) return Promise.resolve("deny");
    const lifecycleGeneration = this.utilityLifecycleGeneration ?? 0;
    if (this.mobileUtilityFallbackApproval && !sameUtilityFallbackConsentContext(context, this.mobileUtilityFallbackApproval)) {
      this.mobileUtilityFallbackApproval = undefined;
    }
    if (this.mobileUtilityFallbackApproval) return Promise.resolve(this.mobileUtilityFallbackApproval.decision);
    const inFlight = this.mobileUtilityFallbackConsentInFlight;
    if (inFlight && sameUtilityFallbackConsentContext(context, inFlight)) {
      return inFlight.promise;
    }
    if (this.mobileUtilityFallbackConsentInFlight) {
      // A different destination appeared while the old disclosure was open.
      // Close the stale modal fail-safe before showing the current one.
      this.mobileUtilityFallbackModal?.close();
      this.mobileUtilityFallbackModal = null;
    }
    const pending = this.askMobileUtilityFallback(context).then((choice) => {
      if (!this.isUtilityLifecycleActive(lifecycleGeneration)) return "deny";
      const decision = choice;
      const cached = this.mobileUtilityFallbackApproval;
      // Denial is monotonic for concurrent callers in this exact context: no
      // late/racing Allow can replace it.
      if (!sameUtilityFallbackConsentContext(context, cached) || cached?.decision !== "deny") {
        this.mobileUtilityFallbackApproval = {
          identity: context.identity,
          destinationFingerprint: context.destinationFingerprint,
          decision,
        };
        return decision;
      }
      return cached.decision;
    });
    const shared = pending.finally(() => {
      if (this.mobileUtilityFallbackConsentInFlight?.promise === shared) this.mobileUtilityFallbackConsentInFlight = null;
    });
    this.mobileUtilityFallbackConsentInFlight = {
      identity: context.identity,
      destinationFingerprint: context.destinationFingerprint,
      promise: shared,
    };
    return shared;
  }

  private runtimeUtilitySelection(): RuntimeUtilitySelection {
    const router = this.router();
    const context = router.utilityFallbackConsentContext(Platform.isMobile);
    if (this.mobileUtilityFallbackApproval && !sameUtilityFallbackConsentContext(this.mobileUtilityFallbackApproval, context)) {
      this.mobileUtilityFallbackApproval = undefined;
    }
    return router.resolveUtilityForRuntime({
      isMobile: Platform.isMobile,
      ...(this.mobileUtilityFallbackApproval ? { fallbackApproval: this.mobileUtilityFallbackApproval.decision } : {}),
    });
  }

  /** Runtime-selected utility backend shown alongside Inbox batch controls. */
  sourceEnrichmentBackendLabel(): string {
    const selection = this.runtimeUtilitySelection();
    if (selection.state === "unavailable-loopback") return "Unavailable on mobile · Claude approval required";
    if (selection.state === "unavailable-without-Claude") {
      return selection.reason === "invalid-endpoint" ? "Unavailable · invalid utility endpoint" : "Unavailable on mobile";
    }
    if (selection.provider.id === "anthropic") return `Claude (Anthropic API) · ${selection.model}`;
    if (selection.provider.id === "ollama") return `Ollama · ${selection.model}`;
    return `OpenAI-compatible endpoint · ${selection.model}`;
  }

  private providerEndpoint(provider: ProviderId): string | undefined {
    if (provider === "ollama") return sanitizeEndpointForDisplay(this.settings.ollamaHost);
    if (provider === "openai-compat") return sanitizeEndpointForDisplay(this.settings.openaiCompatHost);
    return this.settings.baseUrl.trim() ? sanitizeEndpointForDisplay(this.settings.baseUrl) : undefined;
  }

  private providerErrorHint(message: string, provider: ProviderId): string | null {
    return errorHint(message, provider, this.providerEndpoint(provider));
  }

  private sourceEnrichmentErrorHint(message: string): string | null {
    const selection = this.runtimeUtilitySelection();
    const provider: ProviderId =
      selection.state === "configured-provider" || selection.state === "approved-Claude-fallback"
        ? selection.provider.id
        : selection.backend === "ollama"
          ? "ollama"
          : "openai-compat";
    return this.providerErrorHint(message, provider);
  }

  private askMobileUtilityFallback(context: UtilityFallbackConsentContext): Promise<UtilityFallbackApproval> {
    return new Promise((resolve) => {
      let settled = false;
      let modal: ChoiceModal<UtilityFallbackApproval>;
      const finish = (choice: UtilityFallbackApproval): void => {
        if (settled) return;
        settled = true;
        if (this.mobileUtilityFallbackModal === modal) this.mobileUtilityFallbackModal = null;
        resolve(choice);
      };
      modal = new ChoiceModal<UtilityFallbackApproval>(this.app, {
        title: "Use Claude for mobile enrichment?",
        message:
          `The utility model at ${context.configuredEndpoint} is local to your desktop and cannot be reached from this mobile device. ` +
          `If you continue, ${this.mobileFallbackDestinationLabel(context.fallbackEndpoint)} may receive content for source enrichment, tagging and organization, ` +
          "summaries and frontmatter, and memory consolidation including session content. " +
          "Allow this fallback for the current plugin session?",
        buttons: [
          { label: "Use Claude this session", value: "allow", cta: true },
          { label: "Don't send", value: "deny" },
        ],
        fallback: "deny",
        onChoice: finish,
      });
      this.mobileUtilityFallbackModal = modal;
      modal.open();
    });
  }

  private mobileFallbackDestinationLabel(endpoint: string): string {
    return endpoint === ANTHROPIC_DEFAULT_BASE_URL
      ? `Claude (Anthropic API at ${endpoint})`
      : `an Anthropic-compatible gateway at ${endpoint}`;
  }

  private utilityUnavailableMessage(selection: Exclude<RuntimeUtilitySelection, { state: "configured-provider" | "approved-Claude-fallback" }>): string {
    const endpoint = selection.endpoint || "(empty endpoint)";
    if (selection.state === "unavailable-loopback") {
      return `The configured ${selection.backend} utility endpoint ${endpoint} is unavailable on mobile until Claude fallback is approved.`;
    }
    if (selection.reason === "invalid-endpoint") {
      return `The configured ${selection.backend} utility endpoint “${endpoint}” is invalid. Configure a valid LAN or remote endpoint in Companion settings.`;
    }
    if (selection.reason === "mobile-local-endpoint") {
      return `The configured ${selection.backend} utility endpoint ${endpoint} is local to this device and unavailable for mobile utility calls. Configure a LAN or remote endpoint.`;
    }
    if (selection.reason === "claude-unavailable") {
      if (selection.backend === "claude") {
        return `The Claude utility backend is unavailable because no Anthropic credential is configured. Add a credential in Companion settings.`;
      }
      return `The configured ${selection.backend} utility endpoint ${endpoint} is unavailable on mobile, and no Anthropic credential is configured for Claude fallback. Add a credential or configure a LAN or remote endpoint in Companion settings.`;
    }
    return `The configured ${selection.backend} utility endpoint ${endpoint} is unavailable on mobile, and sending note content to Claude was not approved for this session. Configure a LAN or remote endpoint, or restart Obsidian to choose again.`;
  }

  /**
   * Write one Web Clipper template per source type into the vault so clips land
   * pre-typed (schema keys + page-known values) instead of clip-then-convert.
   * The user imports the JSON files in the clipper's template settings.
   */
  async exportClipperTemplates(): Promise<{ folder: string; count: number }> {
    const folder = "Claude/Clipper templates";
    const opts = { path: this.settings.sourceInboxFolder, tags: this.settings.sourceBaseTags };
    const types: SourceType[] = ["article", "video", "dataset"];
    const schemas = types.map((t) => getSchema(t, this.settings.sourceSchemaOverrides));
    await ensureVaultFolder(this.app, folder);
    for (const schema of schemas) {
      const template = clipperTemplateFor(schema, opts);
      await writeOrReplaceFile(this.app, normalizePath(`${folder}/${clipperTemplateFileName(template)}`), serializeClipperTemplate(template));
    }
    this.settings.clipperTemplateFingerprint = clipperFingerprint(schemas, opts);
    await this.saveSettings();
    new Notice(
      `Wrote ${types.length} clipper templates to “${folder}”. In the Web Clipper extension: Settings → Templates → Import each file — clips will then arrive already typed for Companion.`,
      10000,
    );
    return { folder, count: types.length };
  }

  private clipperSetups(): ClipperSetupViewModel[] {
    const schemas = (["article", "video", "dataset"] as SourceType[]).map((type) => getSchema(type, this.settings.sourceSchemaOverrides));
    return (["article", "video", "dataset"] as SourceType[]).map((type) => clipperSetupFor(type, schemas, {
      inboxFolder: this.settings.sourceInboxFolder,
      baseTags: this.settings.sourceBaseTags,
      savedFingerprint: this.settings.clipperVerification[type]?.fingerprint ?? this.settings.clipperTemplateFingerprint,
    }));
  }

  openClipperSetup(): void {
    new ClipperSetupModal(this.app, {
      setups: () => this.clipperSetups(),
      copyText: async (text) => {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable on this device.");
        await navigator.clipboard.writeText(text);
      },
      onCopied: async (type, fingerprint) => {
        this.settings.clipperVerification[type] = {
          fingerprint,
          state: "waiting",
          startedAt: Date.now(),
          mismatches: [],
        };
        await this.persist();
        this.activity.start({
          id: `clipper-verification:${type}`,
          kind: "clipper-verification",
          title: `Waiting for a ${type} test clip`,
        });
      },
      saveJson: async (setup) => {
        const folder = "Claude/Clipper templates";
        await ensureVaultFolder(this.app, folder);
        await writeOrReplaceFile(this.app, normalizePath(`${folder}/companion-${setup.type}-clipper.json`), setup.json);
        new Notice(`Saved ${setup.templateName} JSON to ${folder}.`, 4000);
      },
    }).open();
  }

  private queueClipperVerification(file: TFile, attempt = 0): void {
    const waiting = Object.entries(this.settings.clipperVerification)
      .filter((entry): entry is [SourceType, NonNullable<typeof entry[1]>] => entry[1]?.state === "waiting")
      .sort((left, right) => right[1].startedAt - left[1].startedAt)[0];
    if (!waiting) return;
    const previous = this.clipperVerificationTimers.get(file.path);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this.clipperVerificationTimers.delete(file.path);
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!frontmatter && attempt < 4) {
        this.queueClipperVerification(file, attempt + 1);
        return;
      }
      // A clip that lands in the inbox carrying nothing is proof the template
      // never applied — report it instead of waiting for a note that can't come.
      if (!frontmatter) {
        const inbox = this.settings.sourceInboxFolder.replace(/\/+$/, "");
        if (inbox && file.path.startsWith(`${inbox}/`)) void this.verifyArrivingClip(file, waiting[0], {});
        return;
      }
      const observedType = frontmatter.type;
      const typedWaiting = (observedType === "article" || observedType === "video" || observedType === "dataset")
        && this.settings.clipperVerification[observedType]?.state === "waiting"
        ? observedType
        : undefined;
      const resemblesClip = frontmatter.source !== undefined || frontmatter.url !== undefined || frontmatter.schema_version !== undefined;
      const expectedType = typedWaiting ?? (resemblesClip ? waiting[0] : undefined);
      if (!expectedType) return;
      void this.verifyArrivingClip(file, expectedType, frontmatter);
    }, 600);
    this.clipperVerificationTimers.set(file.path, timer);
  }

  private async verifyArrivingClip(file: TFile, type: SourceType, frontmatter: Record<string, unknown>): Promise<void> {
    const metadata = this.settings.clipperVerification[type];
    if (!metadata || metadata.state !== "waiting") return;
    const schema = getSchema(type, this.settings.sourceSchemaOverrides);
    const result = verifyClipperNote({ path: file.path, frontmatter }, {
      type,
      schemaVersion: schema.version,
      destination: this.settings.sourceInboxFolder,
      fingerprint: metadata.fingerprint,
      baseTags: this.settings.sourceBaseTags,
    });
    this.settings.clipperVerification[type] = {
      fingerprint: metadata.fingerprint,
      state: result.state,
      startedAt: metadata.startedAt,
      ...(result.state === "verified" ? { verifiedAt: Date.now() } : {}),
      path: result.path,
      mismatches: result.mismatches.slice(0, 12),
    };
    await this.persist();
    const activityId = `clipper-verification:${type}`;
    if (!this.activity.snapshot().records.some(({ id }) => id === activityId)) {
      this.activity.start({ id: activityId, kind: "clipper-verification", title: `Verifying ${type} Web Clipper template`, total: 1 });
    }
    if (result.state === "verified") {
      this.activity.finish(activityId, {
        completed: 1,
        total: 1,
        succeeded: 1,
        details: [{ label: result.path, message: "Template verified from an arriving clip", state: "success" }],
      });
    } else {
      this.activity.fail(activityId, {
        completed: 1,
        total: 1,
        failed: 1,
        details: result.mismatches.map(({ field, expected, observed }) => ({
          label: field,
          message: `Expected ${expected}; observed ${observed}`,
          state: "error" as const,
        })),
        recovery: [{ id: "clipper-schemas", label: "Copy updated JSON", kind: "retry" }],
      });
    }
  }

  /** True when schemas/inbox/tags moved on since the last template export. */
  clipperTemplatesStale(): boolean {
    const saved = this.settings.clipperTemplateFingerprint;
    if (!saved) return false; // never exported → nothing to be stale
    const opts = { path: this.settings.sourceInboxFolder, tags: this.settings.sourceBaseTags };
    const schemas = (["article", "video", "dataset"] as SourceType[]).map((t) => getSchema(t, this.settings.sourceSchemaOverrides));
    return clipperFingerprint(schemas, opts) !== saved;
  }

  private isUtilityLifecycleActive(generation: number): boolean {
    return !this.utilityLifecycleEnded && (this.utilityLifecycleGeneration ?? 0) === generation;
  }

  private assertUtilityLifecycleActive(generation: number): void {
    if (!this.isUtilityLifecycleActive(generation)) {
      throw new Error("Companion unloaded while utility work was in flight; the result was discarded without writing.");
    }
  }

  /**
   * Clipping organizer: enrich every unenriched inbox clip (meaningful title,
   * tags, summary via the existing pipeline), batch-infer a domain folder per
   * clip, review the proposed rename+move plan, then apply the accepted subset.
   */
  async organizeClippings(): Promise<void> {
    const inbox = this.settings.sourceInboxFolder.replace(/\/+$/, "");
    const base = this.settings.clipOrganizedFolder.replace(/\/+$/, "");
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => (f.path === inbox || f.path.startsWith(`${inbox}/`)) && !(base && (f.path === base || f.path.startsWith(`${base}/`))));
    if (files.length === 0) {
      new Notice(`No clippings found in ${inbox}/.`);
      return;
    }

    const pending = new Notice(`Organizing ${files.length} clipping${files.length === 1 ? "" : "s"}…`, 0);
    try {
      // 1) Enrich anything not yet enriched. A failed/denied item aborts the
      // organizer so it cannot be sent through another provider or defaulted
      // into a misleading misc move.
      for (const file of files) {
        const content = await this.app.vault.cachedRead(file);
        if (!/^source_enriched:\s*true\s*$/m.test(content)) {
          const outcome = await this.enrichment().enrichFile(file);
          if (outcome.status !== "enriched") {
            const detail = outcome.status === "failed" ? outcome.error.message : outcome.reason;
            new Notice(`Organizing stopped — ${detail}`);
            return;
          }
        }
      }

      // 2) Titles + summaries from the (now enriched) frontmatter.
      const candidates: OrganizeCandidate[] = [];
      const titles = new Map<string, string>();
      for (const file of files) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        const title = typeof fm?.title === "string" && fm.title.trim() ? fm.title.trim() : file.basename;
        const summary = typeof fm?.summary === "string" ? fm.summary.trim() : "";
        titles.set(file.path, title);
        candidates.push({ path: file.path, title, summary });
      }

      // 3) One batch call infers the domain folder for the whole set.
      const existingFolders = [...new Set(this.app.vault.getMarkdownFiles().map((f) => f.parent?.path ?? "").filter((p) => p.startsWith(`${base}/`)))].sort();
      const { system, user } = buildOrganizePrompt(candidates, existingFolders);
      let proposals = candidates.map((c) => ({ path: c.path, domain: "misc" }));
      try {
        const raw = (
          await this.router().complete("utility", {
            system,
            user,
            maxTokens: 2048,
            responseFormat: "json",
            thinking: { type: "disabled" },
          })
        ).text;
        proposals = parseOrganizeResponse(raw, candidates);
      } catch (e) {
        if (e instanceof UtilityUnavailableError) {
          new Notice(`Organizing stopped — ${e.message}`);
          return;
        }
        // Folder inference failed — the review modal still offers the misc move.
      }

      // 4) Review, then apply the accepted subset.
      const moves = planOrganizeMoves(proposals, titles, { baseFolder: base, taken: (p) => this.app.vault.getAbstractFileByPath(p) !== null });
      pending.hide();
      if (moves.length === 0) {
        new Notice("Everything is already named and filed.");
        return;
      }
      new OrganizeReviewModal(this.app, moves, (accepted) => {
        if (!accepted || accepted.length === 0) return;
        void (async () => {
          let moved = 0;
          for (const move of accepted) {
            const file = this.app.vault.getAbstractFileByPath(move.from);
            if (!(file instanceof TFile)) continue;
            const dir = move.to.slice(0, move.to.lastIndexOf("/"));
            await ensureVaultFolder(this.app, dir);
            await this.app.fileManager.renameFile(file, move.to);
            moved++;
          }
          new Notice(`Organized ${moved} clipping${moved === 1 ? "" : "s"} into ${base}/.`);
        })();
      }).open();
    } finally {
      pending.hide();
    }
  }

  /** Tracks the Build header-action element we added to each plan-note view. */  private planBuildActions = new WeakMap<MarkdownView, HTMLElement>();
  /** Most recently focused markdown file — side views (Desk, Chat) steal active-leaf, so "active note" flows must remember it. */
  private lastMarkdownFile: TFile | null = null;

  /**
   * Add (or remove) a "Build" icon in the header of every open markdown note that
   * declares `type: plan` in frontmatter, wired to build that specific note. A
   * note becomes "canonical" by carrying `type: plan`.
   */
  private syncPlanBuildActions(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const fm = view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : null;
      const isPlan = fm?.type === "plan";
      const existing = this.planBuildActions.get(view);
      if (isPlan && !existing) {
        const file = view.file;
        const action = view.addAction("hammer", "Build this plan with Claude", () => void this.handoffToBuild(file ?? undefined));
        this.planBuildActions.set(view, action);
      } else if (!isPlan && existing) {
        existing.remove();
        this.planBuildActions.delete(view);
      }
    }
  }

  /** Stamp `type: plan` onto a note so it gets the Build affordance. */
  async markNoteAsPlan(file: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      (fm as Record<string, unknown>).type = "plan";
    });
    this.syncPlanBuildActions();
    new Notice("Marked as a plan — a Build icon is now in the note's header.");
  }

  /**
   * Inline rewrite (roadmap Track B): selection → instruction modal → one
   * chat-free completion → per-hunk DiffModal review → vault.process apply.
   * When the selection isn't unique in the note, the diff is planned against
   * the selection alone and the apply is anchored at the editor offsets.
   */
  private async runInlineRewrite(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file;
    const selection = editor.getSelection();
    if (!file || selection.trim().length === 0) {
      new Notice("Select some text to rewrite first.");
      return;
    }
    const anchorFrom = editor.posToOffset(editor.getCursor("from"));
    const anchorTo = editor.posToOffset(editor.getCursor("to"));

    const instruction = await new Promise<string | null>((resolve) =>
      new RewriteModal(this.app, selection.length, resolve).open(),
    );
    if (!instruction) return;

    const progress = new Notice("Rewriting selection…", 0);
    try {
      const { text: raw } = await this.router().complete("chat", {
        system: REWRITE_SYSTEM,
        user: buildRewriteUser(selection, instruction),
        maxTokens: rewriteMaxTokens(selection),
        temperature: 0.3,
      });
      const rewritten = parseRewrite(raw, selection);

      const cm = this.settings.inlineDiffEnabled ? editorViewOf(editor) : null;
      if (cm && editor.getValue().slice(anchorFrom, anchorTo) === selection) {
        const session = createRangeSession(editor.getValue(), { from: anchorFrom, to: anchorTo, newText: rewritten }, { path: file.path, description: `Rewrite — ${instruction}` });
        progress.hide();
        const accepted = await reviewInline(cm, session);
        if (accepted) new Notice("Rewrite applied.");
        return;
      }

      const content = editor.getValue();
      let plan: EditPlan;
      let anchor: { start: number; end: number } | null = null;
      try {
        plan = planEdits(content, [{ old_str: selection, new_str: rewritten }]);
      } catch {
        plan = planEdits(selection, [{ old_str: selection, new_str: rewritten }]);
        anchor = { start: anchorFrom, end: anchorTo };
      }

      const accepted = await new Promise<boolean[] | null>((resolve) =>
        new DiffModal(this.app, { path: file.path, description: `Rewrite — ${instruction}`, plan }, resolve).open(),
      );
      if (!accepted) return;

      await this.app.vault.process(file, (current) => {
        if (anchor && current.slice(anchor.start, anchor.end) === selection) {
          return accepted[0] ? current.slice(0, anchor.start) + rewritten + current.slice(anchor.end) : current;
        }
        return applyPlan(current, plan, accepted);
      });
      new Notice("Rewrite applied.");
    } catch (e) {
      const { provider } = this.router().resolve("chat");
      const hint = this.providerErrorHint(e instanceof Error ? e.message : String(e), provider.id);
      new Notice(`Rewrite failed${hint ? ` — ${hint}` : ` — ${e instanceof Error ? e.message : String(e)}`}`);
    } finally {
      progress.hide();
    }
  }

  /** Shared chat-free rewrite helper for the research surfaces (claims, evidence, project questions). */
  private researchRewriteText(): (input: { text: string; instruction: string; context?: string }) => Promise<string> {
    return async ({ text, instruction, context }) => {
      const { text: raw } = await this.router().complete("chat", {
        system: REWRITE_SYSTEM,
        user: context ? buildGroundedRewriteUser(text, instruction, context) : buildRewriteUser(text, instruction),
        maxTokens: rewriteMaxTokens(text),
        temperature: 0.3,
      });
      return parseRewrite(raw, text);
    };
  }

  /**
   * One-click clippings triage (Research Desk): enrich any un-typed clips in
   * the inbox, group them into research themes with one chat call, tag each
   * note with its theme, and write a `Triage.md` board with links and a
   * potential project per theme. Manual action — no consent gate.
   */
  private async triageClippings(): Promise<void> {
    const folder = this.settings.sourceInboxFolder.replace(/\/+$/, "");
    if (!folder) {
      new Notice("Set a clippings inbox folder in Companion settings first.");
      return;
    }
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder}/`) && f.name !== "Triage.md");
    if (files.length === 0) {
      new Notice(`No clippings in ${folder}/ yet — clip something first.`);
      return;
    }
    const progress = new Notice(`Triaging ${files.length} clipping${files.length === 1 ? "" : "s"}…`, 0);
    try {
      for (const file of files) {
        const content = await this.app.vault.cachedRead(file);
        if (/^source_enriched:\s*true\s*$/m.test(content)) continue;
        const outcome = await this.enrichment().runEnrich(file, false);
        if (outcome.status === "failed") throw outcome.error;
        if (outcome.status === "skipped") throw new Error(outcome.reason);
      }

      const notes: TriageNote[] = [];
      for (const file of files) {
        const content = await this.app.vault.cachedRead(file);
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const tags = Array.isArray(fm?.tags) ? fm.tags.map(String) : typeof fm?.tags === "string" ? [fm.tags] : [];
        notes.push({
          path: file.path,
          title: typeof fm?.title === "string" ? fm.title : file.basename,
          type: typeof fm?.type === "string" ? fm.type : "note",
          ...(typeof fm?.url === "string" ? { url: fm.url } : {}),
          tags,
          excerpt: noteExcerpt(content),
        });
      }

      const { text: raw } = await this.router().complete("chat", {
        system: TRIAGE_SYSTEM,
        user: buildTriageUser(notes),
        maxTokens: 4000,
        temperature: 0.2,
      });
      const groups = parseTriageResponse(raw, new Set(notes.map((n) => n.path)));
      if (groups.length === 0) throw new Error("The model returned no usable groups — try again.");

      for (const group of groups) {
        const tag = themeTagSlug(group.theme);
        for (const path of group.paths) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) continue;
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            const record = fm as Record<string, unknown>;
            const raw = record.tags;
            const existing: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
            record.tags = [...new Set([...existing, tag])];
          });
        }
      }

      const triagePath = normalizePath(`${folder}/Triage.md`);
      const board = renderTriageNote(groups, new Map(notes.map((n) => [n.path, n])), new Date().toISOString());
      this.enrichment().markEnrichRecentlyWritten(triagePath);
      const existing = this.app.vault.getAbstractFileByPath(triagePath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, board);
      else await this.app.vault.create(triagePath, board);
      new Notice(`Triage: ${groups.length} theme${groups.length === 1 ? "" : "s"} across ${files.length} clippings → ${triagePath}`);
      const boardFile = this.app.vault.getAbstractFileByPath(triagePath);
      if (boardFile instanceof TFile) await this.app.workspace.getLeaf(false).openFile(boardFile);
    } catch (e) {
      const { provider } = this.router().resolve("chat");
      const hint = this.providerErrorHint(e instanceof Error ? e.message : String(e), provider.id);
      new Notice(`Triage failed${hint ? ` — ${hint}` : ` — ${e instanceof Error ? e.message : String(e)}`}`);
    } finally {
      progress.hide();
    }
  }

  /**
   * Seed a research project from the open note: pre-draft a sharp question
   * grounded in the note, confirm via the create-project modal, import the
   * note as the first source, then land on Discover so the preliminary
   * scholarly search is one click away.
   */
  private async startResearchFromActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.lastMarkdownFile;
    if (!file) {
      new Notice("Open a note first — it becomes the project's first source.");
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    if (content.trim().length < 200) {
      new Notice("That note is too short to seed a research project.");
      return;
    }
    let question: string | undefined;
    const drafting = new Notice("Drafting a research question from the note…", 0);
    try {
      question = await this.researchRewriteText()({ text: file.basename, instruction: QUESTION_INSTRUCTION, context: noteExcerpt(content, 3000) });
    } catch (e) {
      console.warn("[companion] question drafting failed", e);
    } finally {
      drafting.hide();
    }
    new ProjectCreateModal(this.app, async (input) => {
      const record = await this.researchRepository().createProject(input);
      const url = parseClipUrl(content);
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      await this.researchRepository().importSource(record.path, {
        title: file.basename,
        sourceKind: "vault",
        ...(url ? { url } : {}),
        capturedContent: body.slice(0, 50000),
      });
      new Notice(`Project started with “${file.basename}” as the first source — press Search in Discover for preliminary materials.`);
      await this.activateResearchWorkbench(record.path, "Discover");
    }, this.researchRewriteText(), { title: file.basename, folder: `Research/${file.basename}`, ...(question ? { question } : {}) }).open();
  }

  override onunload(): void {
    for (const dispose of [...(this.disposables ?? [])].reverse()) dispose();
    this.disposables = [];
    this.settingsListeners?.clear();
    void this.closeCliSessions();
    this._activity?.dispose();
    this.utilityLifecycleEnded = true;
    this.utilityLifecycleGeneration = (this.utilityLifecycleGeneration ?? 0) + 1;
    this._enrichment?.destroy();
    this.mobileUtilityFallbackApproval = undefined;
    this.mobileUtilityFallbackModal?.close();
    this.mobileUtilityFallbackModal = null;
    this.mobileUtilityFallbackConsentInFlight = null;
    for (const timer of this.clipperVerificationTimers?.values() ?? []) window.clearTimeout(timer);
    this.clipperVerificationTimers?.clear();
    this._intelligenceCoordinator?.cancel();
    this._intelligenceCoordinator = null;
    this._discoveryCoordinator?.cancel();
    this._discoveryCoordinator?.clearCache();
    this._discoveryCoordinator = null;
    for (const modal of this._desktopIntegrationModals ?? []) modal.close();
    this._desktopIntegrationModals?.clear();
    for (const coordinator of this._viewIntelligenceCoordinators ?? []) coordinator.cancel();
    this._viewIntelligenceCoordinators?.clear();
    for (const coordinator of this._viewDiscoveryCoordinators ?? []) { coordinator.cancel(); coordinator.clearCache(); }
    this._viewDiscoveryCoordinators?.clear();
    this._build?.destroy();
    this.mcpLifecycleEnded = true;
    this.mcpLifecycleGeneration = (this.mcpLifecycleGeneration ?? 0) + 1;
    this._mcpBridge?.destroy();
    void this._externalMcp?.close();
    this._externalMcp = null;
    this._semantic?.destroy();
    if (this._ontologyReloadTimer !== null) window.clearTimeout(this._ontologyReloadTimer);
    if (this.researchRefreshTimer !== null) window.clearTimeout(this.researchRefreshTimer);
    if (this.inboxBadgeTimer !== null) window.clearTimeout(this.inboxBadgeTimer);
  }

  /** Lazy external-MCP manager; null until first configured use. */
  externalMcp(): ExternalMcpManager {
    if (!this._externalMcp) this._externalMcp = new ExternalMcpManager(() => this.settings.mcpClientServers);
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

  companionChrome(): CompanionChromeDependencies {
    return {
      app: this.app,
      activity: this.activity,
      snapshot: () => this.quickOptionsSnapshot(),
      save: (change) => this.saveQuickOption(change),
      run: (action) => this.runQuickOption(action),
      openAllSettings: () => this.openCompanionSettings(),
      openDesktopIntegrations: () => this.openDesktopIntegrations(),
      runActivityRecovery: (activityId, actionId) => this.runActivityRecovery(activityId, actionId),
      dismissActivity: (activityId) => this.activity.dismiss(activityId),
    };
  }

  private quickOptionsSnapshot(): QuickOptionsState {
    const clipperStatuses = this.clipperSetups().map(({ status }) => status);
    const clipperStatus = clipperStatuses.includes("update-available")
      ? "update-available" as const
      : clipperStatuses.every((status) => status === "current")
        ? "current" as const
        : "not-set-up" as const;
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
      chatBackend: this.settings.chatBackend,
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
      ...this.semantic().indexerHealth(),
      memoryEnabled: this.settings.memoryEnabled,
      memoryFolder: this.settings.memoryFolder,
      memoryAutoConsolidate: this.settings.memoryAutoConsolidate,
      discoveryEnabled: this.settings.discoveryEnabled,
      discoveryReranker: this.settings.discoveryReranker,
    };
  }

  private async saveQuickOption(change: QuickOptionChange): Promise<void> {
    const value = change.value;
    switch (change.id) {
      case "chat-backend":
        if (value === "claude" || value === "local" || value === "auto" || value === "custom") this.settings.chatBackend = value;
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
        if (value === "builtin" || value === "ollama" || value === "custom") this.settings.embeddingEngine = value;
        else throw new Error("Choose a valid embedding engine.");
        break;
      case "memory-enabled": this.settings.memoryEnabled = value === true; break;
      case "memory-folder": this.settings.memoryFolder = String(value).trim() || "Claude/Memory"; break;
      case "discovery-enabled": this.settings.discoveryEnabled = value === true; break;
      case "discovery-reranker":
        if (value === "current" || value === "claude" || value === "local" || value === "disabled") this.settings.discoveryReranker = value;
        else throw new Error("Choose a valid discovery reranker.");
        break;
      default: throw new Error("That quick setting is not available.");
    }
    await this.saveSettings();
  }

  private async runQuickOption(action: QuickOptionAction): Promise<void> {
    switch (action.id) {
      case "clipper-schemas": this.openClipperSetup(); return;
      case "embedding-health":
      case "embedding-settings": this.openCompanionSettings(); return;
      case "rebuild-index":
      case "retry-index": await this.rebuildSemanticIndex(); return;
      case "consolidate-memory": await this.memory().consolidateMemory(); return;
      case "clippings-inbox": await this.activateInboxView(); return;
      case "review-inbox-failures": await this.activateInboxView(); return;
      case "utility-settings": this.openCompanionSettings(); return;
      case "download-builtin": await this.downloadBuiltinModelAndIndex(); return;
      case "use-builtin-embeddings":
        this.settings.embeddingEngine = "builtin";
        await this.saveSettings();
        if (!(await this.canEmbedWithoutDownload())) await this.downloadBuiltinModelAndIndex();
        else await this.rebuildSemanticIndex();
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

  openDesktopIntegrations(): void {
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
    if (!this.resolvedMcpToken()) this.settings.mcpToken = generateToken();
    await this.saveSettings();
    if (!this.mcpRunning()) throw new Error(`The read-only MCP bridge could not start on port ${this.settings.mcpPort}.`);
    const token = this.resolvedMcpToken();
    if (!token) throw new Error("The MCP bridge did not produce an access token.");
    return { port: this.settings.mcpPort, token };
  }

  private async createDesktopIntegrationController(): Promise<DesktopIntegrationCoordinator> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("This vault does not expose a desktop filesystem path.");
    const processLike = (window as { process?: { platform?: string; env?: Record<string, string | undefined> } }).process;
    const platform: DesktopPlatform = processLike?.platform === "darwin" || processLike?.platform === "win32" || processLike?.platform === "linux"
      ? processLike.platform
      : "unsupported";
    const env = processLike?.env ?? {};
    const homeDir = env.HOME || env.USERPROFILE || "";
    if (!homeDir) throw new Error("The desktop home directory is unavailable.");
    const module = await this._desktopRuntimeLoader();
    const runtime = await module.createNodeDesktopRuntime(platform, homeDir, { APPDATA: env.APPDATA });
    return new DesktopIntegrationCoordinator({
      runtime,
      providerReady: () => this.router().anthropic.hasCredentials() || this.settings.chatBackend !== "claude",
      vaultPath: adapter.getBasePath(),
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
      openConnectionSettings: () => this.openCompanionSettings(),
      openBridgeSettings: () => this.openCompanionSettings(),
      openObsidianCliSettings: () => this.openObsidianCliSettings(),
      confirm: (target, message) => this.confirmDesktopIntegration(target, message),
      ...(configPath ? { claudeDesktopConfigPath: configPath } : {}),
      closed: () => this._desktopIntegrationModals?.delete(modal),
    });
    (this._desktopIntegrationModals ??= new Set()).add(modal);
    modal.open();
  }

  private mobileDesktopIntegrationsController(): DesktopIntegrationsController {
    const state = { status: "idle" as const, providerReady: this.router().anthropic.hasCredentials() || this.settings.chatBackend !== "claude" };
    return {
      snapshot: () => state,
      subscribe: () => () => undefined,
      refresh: async () => undefined,
      setupClaudeCode: async () => undefined,
      connectClaudeDesktop: async () => undefined,
      openTerminal: async () => undefined,
      dispose: () => undefined,
    };
  }

  private confirmDesktopIntegration(target: "claude-code" | "claude-desktop", message: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ChoiceModal(this.app, {
        title: target === "claude-code" ? "Set up Claude Code?" : "Connect Claude Desktop?",
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

  embeddingRecovery(error: unknown): EmbeddingRecovery {
    return this.semantic().embeddingRecovery(error);
  }

  async runActivityRecovery(activityId: string, actionId: string): Promise<void> {
    if (activityId.startsWith("chat-turn:")) {
      const conversationId = activityId.slice("chat-turn:".length);
      const conversation = this.conversations().list().find(({ id }) => id === conversationId);
      if (!conversation) throw new Error("That conversation no longer exists.");
      if (actionId === "stop-chat-turn") {
        if (!conversation.activeTurn) return;
        await this.stopActiveChatTurn(conversationId, conversation.activeTurn.id);
        return;
      }
      await this.setActiveConversation(conversationId);
      const view = await this.activateView();
      view?.loadConversation(this.getActiveConversation() ?? conversation);
      if (actionId === "resume-chat-turn") {
        const active = this.getActiveConversation();
        if (view && active) await view.resumeInterruptedTurn(active);
      }
      return;
    }
    if (actionId === "copy-diagnostics") {
      const logPath = "Claude/enrichment-diagnostics.log";
      if (!(await this.app.vault.adapter.exists(logPath))) throw new Error("No enrichment diagnostics log exists yet — turn on the toggle in Settings → Source capture and run Enrich all again.");
      const text = await this.app.vault.adapter.read(logPath);
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable on this device.");
      await navigator.clipboard.writeText(text.slice(-8192));
      return;
    }
    if (actionId === "copy-details") {
      const details = this.activity.snapshot().records.find(({ id }) => id === activityId)?.technicalDetails;
      if (!details) throw new Error("No technical details are available for this activity.");
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable on this device.");
      await navigator.clipboard.writeText(details);
      return;
    }
    await this.runQuickOption({ id: actionId, page: "related", activityId });
  }

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
      ? fromPersisted({ conversations: (raw).conversations, activeId: (raw).activeConversationId })
      : emptyState();
    this.conversations().restoreTurnActivities();
    this.researchDeskPreferences = normalizeDeskPreferenceMap(isNamespacedData(raw) ? (raw).researchDeskPreferences : undefined);
    this.build().restoreState(
      isNamespacedData(raw) ? raw.buildRuns : undefined,
      isNamespacedData(raw) ? raw.activeBuildRunId : null,
    );

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
  private async persist(): Promise<void> {
    const store = this.secrets();
    // Credentials the store proved it holds are dropped here; any the backend
    // silently refused stay in the file so they are not lost from both places.
    const stripped = stripVerifiedSecrets(this.settings, store);
    this.unverifiedSecrets = stripped.unverified;
    const data = JSON.parse(JSON.stringify({
      settings: stripped.settings,
      conversations: this.convState.conversations,
      activeConversationId: this.convState.activeId,
      researchDeskPreferences: this.researchDeskPreferences,
      ...this.build().serializeState(),
    })) as PersistedData;
    const result = (this.persistChain ?? Promise.resolve()).catch(() => {}).then(() => this.saveData(data));
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

  listConversations(): Conversation[] {
    return this.conversations().list();
  }

  getActiveConversation(): Conversation | null {
    return this.conversations().getActive();
  }

  async saveActiveConversation(messages: ChatMessage[]): Promise<string | null> {
    return this.conversations().saveActive(messages);
  }

  async beginActiveConversationTurn(
    messages: ChatMessage[],
    input: { backend: string; model: string; mode: ChatTurnMode },
  ): Promise<{ conversationId: string; turnId: string }> {
    return this.conversations().beginTurn(messages, input);
  }

  registerActiveChatTurn(conversationId: string, turnId: string, stop: () => void): () => void {
    return this.conversations().registerTurn(conversationId, turnId, stop);
  }

  async stopActiveChatTurn(conversationId: string, turnId: string): Promise<void> {
    return this.conversations().stopTurn(conversationId, turnId);
  }

  async completeActiveConversationTurn(conversationId: string, turnId: string, messages: ChatMessage[]): Promise<void> {
    return this.conversations().completeTurn(conversationId, turnId, messages);
  }

  async interruptActiveConversationTurn(conversationId: string, turnId: string, messages: ChatMessage[], error = "Interrupted"): Promise<void> {
    return this.conversations().interruptTurn(conversationId, turnId, messages, error);
  }

  activeConversationId(): string {
    return this.conversations().activeId();
  }

  async setActiveConversation(id: string): Promise<Conversation | null> {
    return this.conversations().setActive(id);
  }

  async startNewConversation(): Promise<void> {
    return this.conversations().startNew();
  }

  async deleteConversation(id: string): Promise<void> {
    return this.conversations().delete(id);
  }

  private async browseConversations(): Promise<void> {
    const view = await this.activateView();
    view?.openHistory();
  }

  async deleteActiveConversation(): Promise<void> {
    const active = this.getActiveConversation();
    if (!active) {
      new Notice("No active conversation to delete.");
      return;
    }
    await this.deleteConversation(active.id);
    const view = await this.activateView();
    if (!view) return;
    const next = this.getActiveConversation();
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
    for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_WORKBENCH_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof ResearchWorkbenchView) void v.render();
    }
  }

  // ---------- providers ----------

  router(): ProviderRouter {
    if (this._router && !this._router.hasCurrentAnthropicEnvironment()) this._router = null;
    this._cliProvider ??= new ClaudeCliProvider(this.cliRuntime());
    if (!this._router) this._router = new ProviderRouter(this.settings, () => this.resolveUtilitySelectionForSession(), { cliRuntime: this.cliRuntime(), cliProvider: this._cliProvider });
    return this._router;
  }

  intelligenceCoordinator(): IntelligenceCoordinator {
    if (!this._intelligenceCoordinator) {
      this._intelligenceCoordinator = this.buildIntelligenceCoordinator();
    }
    return this._intelligenceCoordinator;
  }

  createIntelligenceCoordinator(): IntelligenceCoordinator {
    const coordinator = this.buildIntelligenceCoordinator();
    (this._viewIntelligenceCoordinators ??= new Set()).add(coordinator);
    return coordinator;
  }

  releaseIntelligenceCoordinator(coordinator: IntelligenceCoordinator): void {
    if (!this._viewIntelligenceCoordinators?.delete(coordinator)) return;
    coordinator.cancel();
  }

  retainIntelligenceCoordinator(coordinator: IntelligenceCoordinator): void {
    (this._viewIntelligenceCoordinators ??= new Set()).add(coordinator);
  }

  private buildIntelligenceCoordinator(): IntelligenceCoordinator {
      return new IntelligenceCoordinator({
        mode: () => this.settings.intelligenceNarrator,
        chatBackend: () => this.settings.chatBackend,
        anthropic: () => ({
          provider: this.router().anthropic,
          model: resolveModelId(this.settings.model, this.settings.customModel),
        }),
        local: () => ({ provider: this.router().ollama, model: this.settings.ollamaModel }),
        localAvailable: () => this.router().localAvailable(),
        maxTokens: () => this.settings.maxTokens,
      });
  }

  /** One lazy coordinator shared by every discovery surface. */
  discoveryCoordinator(): DiscoveryCoordinator {
    if (!this._discoveryCoordinator) {
      this._discoveryCoordinator = this.buildDiscoveryCoordinator();
    }
    return this._discoveryCoordinator;
  }

  createDiscoveryCoordinator(): DiscoveryCoordinator {
    const coordinator = this.buildDiscoveryCoordinator();
    (this._viewDiscoveryCoordinators ??= new Set()).add(coordinator);
    return coordinator;
  }

  releaseDiscoveryCoordinator(coordinator: DiscoveryCoordinator): void {
    if (!this._viewDiscoveryCoordinators?.delete(coordinator)) return;
    coordinator.cancel();
    coordinator.clearCache();
  }

  retainDiscoveryCoordinator(coordinator: DiscoveryCoordinator): void {
    (this._viewDiscoveryCoordinators ??= new Set()).add(coordinator);
  }

  private buildDiscoveryCoordinator(): DiscoveryCoordinator {
      const http = createObsidianDiscoveryHttp();
      const openAlex = {
        search: (query: Parameters<OpenAlexAdapter["search"]>[0], cursor?: string, signal?: AbortSignal) =>
          new OpenAlexAdapter(http, {
            maxResults: normalizeDiscoverySettings(this.settings).discoveryMaxResults,
            ...(this.settings.openAlexContactEmail.trim() ? { contact: this.settings.openAlexContactEmail.trim() } : {}),
          }).search(query, cursor, signal),
        expand: (input: Parameters<OpenAlexAdapter["expand"]>[0], signal?: AbortSignal) =>
          new OpenAlexAdapter(http, {
            maxResults: normalizeDiscoverySettings(this.settings).discoveryExpansionLimit,
            ...(this.settings.openAlexContactEmail.trim() ? { contact: this.settings.openAlexContactEmail.trim() } : {}),
          }).expand(input, signal),
      };
      return new DiscoveryCoordinator({
        openAlex,
        crossref: new CrossrefAdapter(http),
        arxiv: new ArxivAdapter(http),
        repository: this.researchRepository(),
        enabled: () => this.settings.discoveryEnabled,
        cacheHours: () => normalizeDiscoverySettings(this.settings).discoveryCacheHours,
        rerankerMode: () => this.settings.discoveryReranker,
        chatBackend: () => this.settings.chatBackend,
        anthropic: () => ({ provider: this.router().anthropic, model: resolveModelId(this.settings.model, this.settings.customModel) }),
        local: () => ({ provider: this.router().ollama, model: this.settings.ollamaModel }),
        localAvailable: () => this.router().localAvailable(),
      });
  }

  clearDiscoveryCache(): void {
    this._discoveryCoordinator?.clearCache();
    for (const coordinator of this._viewDiscoveryCoordinators ?? []) coordinator.clearCache();
  }

  builtinEmbedder(): TransformersEmbedder { return this.semantic().builtinEmbedder(); }
  async builtinModelCached(): Promise<boolean> { return this.semantic().builtinModelCached(); }
  async clearBuiltinModel(): Promise<number> { return this.semantic().clearBuiltinModel(); }

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

  /** Create the default ontology schema notes (never overwrites), then reload and report. */
  private async seedOntology(): Promise<void> {
    const folder = normalizePath(this.settings.ontologyFolder);
    await ensureVaultFolder(this.app, folder);
    let created = 0;
    for (const f of seedFiles()) {
      const path = normalizePath(`${folder}/${f.fileName}`);
      if (this.app.vault.getAbstractFileByPath(path)) continue; // never overwrite user edits
      await this.app.vault.create(path, f.content);
      created++;
    }
    const result = await this.ontology()?.load();
    const errors = result?.errors ?? [];
    new Notice(created > 0 ? `Seeded ${created} ontology type${created === 1 ? "" : "s"} → ${folder}/` : "Ontology already seeded — nothing to do.");
    if (errors.length > 0) {
      new Notice(`Ontology has ${errors.length} schema error${errors.length === 1 ? "" : "s"} — check the console.`);
      console.warn("[Claude Companion] ontology schema errors:", errors);
    }
  }

  // ---------- first run ----------

  /** Settings-level view of what a fresh install still owes the user. */
  private firstRunState(): FirstRunState {
    const router = this.router();
    return {
      needsCredential: needsCredentialSetup({
        backend: router.chatBackend,
        hasAnthropicCredential: router.anthropic.hasCredentials(),
        hasClaudeCli: router.claudeCli.hasCredentials(),
      }),
      ontologyPending: this.settings.ontologyEnabled && !this.settings.ontologySeedPrompted,
      semanticPending: this.settings.semanticEnabled && !this.settings.semanticModelPrompted,
      integrationsPending: !Platform.isMobile && !this.settings.desktopIntegrationsOffered,
    };
  }

  /** Layout-ready first run: load the ontology, then the ordered consent prompts. */
  private async runFirstRun(): Promise<void> {
    if (this.settings.ontologyEnabled) await this.loadOntologyOnStart();
    await this.runFirstRunPrompts();
  }

  /**
   * Open the optional consent prompts one at a time, in order, skipping them
   * entirely while no credential exists. Each prompt keeps its own deeper
   * preconditions (registry already populated, model already cached).
   */
  async runFirstRunPrompts(): Promise<void> {
    for (const prompt of pendingFirstRunPrompts(this.firstRunState())) {
      if (prompt === "ontology") await this.offerOntologySeed();
      else if (prompt === "semantic") await this.promptSemanticModelIfNeeded();
      else await this.offerDesktopIntegrations();
    }
  }

  /** Startup ontology load: surface schema errors instead of dropping them. */
  async loadOntologyOnStart(): Promise<void> {
    const registry = this.ontology();
    if (!registry) return;
    const { errors } = await registry.load();
    if (errors.length > 0) {
      new Notice(`Ontology has ${errors.length} schema error${errors.length === 1 ? "" : "s"} — check the console.`);
      console.warn("[Claude Companion] ontology schema errors:", errors);
    }
  }

  /** One-time offer to write the default type schemas. Resolves when dismissed. */
  async offerOntologySeed(): Promise<void> {
    const registry = this.ontology();
    if (!registry) return;
    if (registry.resolved().size > 0 || this.settings.ontologySeedPrompted) return;
    this.settings.ontologySeedPrompted = true;
    await this.saveSettings();
    await new Promise<void>((resolve) => {
      new ChoiceModal<"seed" | "skip">(this.app, {
        title: "Set up the vault ontology",
        message:
          `The ontology lets Claude write typed notes (person, project, source…) that conform to schema notes in your vault. ` +
          `Create the default schemas in ${this.settings.ontologyFolder}/ now? You can edit or delete them afterwards, or re-run “Seed ontology” any time.`,
        buttons: [
          { label: "Create default schemas", value: "seed", cta: true },
          { label: "Not now", value: "skip" },
        ],
        fallback: "skip",
        onChoice: (c) => {
          if (c === "seed") void this.seedOntology();
          resolve();
        },
      }).open();
    });
  }

  /** One-time offer to wire Claude Code and Claude Desktop to this vault. Resolves when dismissed. */
  async offerDesktopIntegrations(): Promise<void> {
    if (Platform.isMobile || this.settings.desktopIntegrationsOffered) return;
    this.settings.desktopIntegrationsOffered = true;
    await this.saveSettings();
    await new Promise<void>((resolve) => {
      new ChoiceModal<"open" | "skip">(this.app, {
        title: "Set up desktop integrations",
        message:
          "Install the obsidian-agent plugin for Claude Code and connect Claude Desktop to this vault. " +
          "Both are available later under Settings → Desktop integrations.",
        buttons: [
          { label: "Open desktop integrations", value: "open", cta: true },
          { label: "Not now", value: "skip" },
        ],
        fallback: "skip",
        onChoice: (c) => {
          if (c === "open") this.openDesktopIntegrations();
          resolve();
        },
      }).open();
    });
  }

  /** Queue an ontology reload after schema-note changes (debounced ~500ms). */
  private scheduleOntologyReload(): void {
    if (this._ontologyReloadTimer !== null) window.clearTimeout(this._ontologyReloadTimer);
    this._ontologyReloadTimer = window.setTimeout(() => {
      this._ontologyReloadTimer = null;
      void this.ontology()?.load();
    }, 500);
  }

  composeSystemPrompt(opts?: { agent?: boolean; plan?: boolean }): string {
    let base = `${this.settings.systemPrompt}\n\n${DESIGN_SYSTEM_PROMPT}`;
    const digest = this.ontology()?.digest();
    if (digest) base = `${base}\n\n${digest}`;
    if (opts?.agent) base = `${base}\n\n${AGENT_INSTRUCTION}`;
    if (opts?.agent && opts?.plan) base = `${base}\n\n${PLAN_MODE_INSTRUCTION}`;
    return base;
  }

  /** Every markdown note as a link-candidate (basename + frontmatter aliases). */
  linkCandidates(): LinkCandidate[] {
    return this.app.vault.getMarkdownFiles().map((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      const raw = fm?.aliases;
      const aliases = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw.trim() ? [raw] : [];
      return { path: f.path, basename: f.basename, aliases };
    });
  }

  /** Paths the given note already links to (its outgoing resolved links). */
  linkedTargets(file: TFile): Set<string> {
    const resolved = (this.app.metadataCache as unknown as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
    return new Set(Object.keys(resolved[file.path] ?? {}));
  }

  /**
   * Bulk-link the unlinked mentions of a note through the diff review flow
   * (spec 2026-07-05 link intelligence): every proposed [[link]] is a hunk the
   * user can accept or reject before anything is written.
   */
  async reviewLinkSuggestions(target?: TFile): Promise<void> {
    const file = target ?? this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Open a note first.");
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    const mentions = findUnlinkedMentions(content, this.linkCandidates(), file.path);
    if (mentions.length === 0) {
      new Notice("No unlinked mentions found.");
      return;
    }
    const edits = mentionEdits(content, mentions);
    if (edits.length === 0) {
      new Notice("Mentions found, but none could be linked unambiguously.");
      return;
    }
    // Planning validates the edits; a rejected plan is a notice, never an unhandled rejection.
    let plan;
    try {
      plan = planEdits(content, edits);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return;
    }
    const accepted = await new Promise<boolean[] | null>((resolve) => {
      new DiffModal(this.app, { path: file.path, description: `Link ${plan.hunks.length} unlinked mention${plan.hunks.length === 1 ? "" : "s"}`, plan }, resolve).open();
    });
    if (!accepted) return;
    try {
      await this.app.vault.process(file, (current) => applyPlan(current, plan, accepted));
      new Notice(`Linked ${accepted.filter(Boolean).length} mention${accepted.filter(Boolean).length === 1 ? "" : "s"} in ${file.basename}.`);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    }
  }

  /** Review and apply link proposals for the supplied enriched Inbox notes. */
  async reviewInboxLinkSuggestions(files: TFile[]): Promise<BatchLinkApplyResult | null> {
    return reviewInboxBatchLinks(files, this.linkCandidates(), {
      read: (file) => this.app.vault.cachedRead(file),
      getFile: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
      },
      process: async (file, transform) => { await this.app.vault.process(file, transform); },
      select: (plans) => new Promise((resolve) => {
        new BatchDiffModal(this.app, plans, resolve).open();
      }),
    });
  }

  /**
   * Enrich one note end to end (file-explorer right-click / command): pick the
   * steps (all on by default), then summarize → propose rename + tags/summary,
   * wikilink unlinked mentions, and copyedit — all presented for review as
   * per-item checkboxes + diff hunks before anything is written.
   */
  async enrichNoteFlow(file: TFile, presetOptions?: EnrichOptions): Promise<void> {
    const options =
      presetOptions ?? (await new Promise<EnrichOptions | null>((resolve) => new EnrichOptionsModal(this.app, 1, resolve).open()));
    if (!options) return;

    const progress = new Notice(`Enriching ${file.basename}…`, 0);
    try {
      const proposal = await this.buildEnrichProposal(file, options);
      if (!proposal.rename && !proposal.frontmatter && !proposal.plan) {
        new Notice(`${file.basename} is already in good shape.`);
        return;
      }
      const decision = await new Promise<EnrichDecision | null>((resolve) =>
        new EnrichReviewModal(this.app, proposal, resolve).open(),
      );
      if (!decision) return;
      await this.applyEnrichDecision(file, proposal, decision);
      new Notice(`Enriched ${file.basename}.`);
    } catch (e) {
      new Notice(`Enrich failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.hide();
    }
  }

  /** Batch variant for a folder: one step picker, then per-note review modals. */
  private async enrichFolderFlow(folder: TFolder): Promise<void> {
    const files: TFile[] = [];
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === "md") files.push(child);
        else if (child instanceof TFolder) walk(child);
      }
    };
    walk(folder);
    if (files.length === 0) {
      new Notice(`No notes found in ${folder.path}/.`);
      return;
    }
    const options = await new Promise<EnrichOptions | null>((resolve) => new EnrichOptionsModal(this.app, files.length, resolve).open());
    if (!options) return;
    for (const file of files) {
      await this.enrichNoteFlow(file, options);
    }
  }

  /** Compute everything an enrich pass can propose for one note (no writes). */
  private async buildEnrichProposal(file: TFile, options: EnrichOptions): Promise<EnrichProposal> {
    const content = await this.app.vault.cachedRead(file);
    const proposal: EnrichProposal = { path: file.path };

    let tagResult: { title: string; tags: string[]; summary: string } | null = null;
    if (options.rename || options.frontmatter) {
      try {
        tagResult = await summarizeAndTag(this.router(), content, existingVaultTags(this.app));
      } catch (e) {
        if (e instanceof UtilityUnavailableError) throw e;
        // Tagging is best-effort — links/lint still run.
      }
    }

    // Compose body transforms: links first, then lint the linked text, so the
    // final old→new diff is one consistent set of non-overlapping hunks.
    let body = content;
    if (options.links) {
      const mentions = findUnlinkedMentions(content, this.linkCandidates(), file.path);
      for (const m of [...mentions].sort((a, b) => b.start - a.start)) {
        body = linkMention(body, m);
      }
    }
    if (options.lint && body.trim().length > 0) {
      try {
        const { text } = await this.router().complete("chat", {
          system: LINT_SYSTEM,
          user: buildLintUser(body),
          maxTokens: lintMaxTokens(body),
          temperature: 0.2,
        });
        body = parseLintResponse(text, body) ?? body;
      } catch (e) {
        console.debug("Claude Companion: lint pass failed, keeping prior result", e);
      }
    }
    const edits = diffToEdits(content, body);
    if (edits.length > 0) proposal.plan = planEdits(content, edits);

    if (options.rename && tagResult?.title) {
      const stem = sanitizeFileName(tagResult.title);
      if (stem && stem !== file.basename) {
        const dir = file.parent && file.parent.path !== "/" ? file.parent.path : "";
        let candidate = stem;
        for (let n = 2; this.app.vault.getAbstractFileByPath(dir ? `${dir}/${candidate}.md` : `${candidate}.md`); n++) candidate = `${stem} ${n}`;
        proposal.rename = { from: file.path, to: dir ? `${dir}/${candidate}.md` : `${candidate}.md` };
      }
    }

    if (options.frontmatter && tagResult) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      const existing: string[] = Array.isArray(fm?.tags) ? fm.tags.map(String) : typeof fm?.tags === "string" ? [fm.tags] : [];
      const merged = normalizeTags([...existing, ...tagResult.tags]);
      const addedTags = merged.filter((t) => !existing.includes(t));
      const summary = typeof fm?.summary === "string" && fm.summary.trim() ? "" : tagResult.summary;
      if (addedTags.length > 0 || summary) proposal.frontmatter = { tags: merged, summary, addedTags };
    }

    return proposal;
  }

  /** Apply the reviewed subset: content hunks, frontmatter, then the rename last. */
  private async applyEnrichDecision(
    file: TFile,
    proposal: EnrichProposal,
    decision: EnrichDecision,
  ): Promise<void> {
    if (proposal.plan && decision.accepted.some(Boolean)) {
      const plan = proposal.plan;
      await this.app.vault.process(file, (current) => applyPlan(current, plan, decision.accepted));
    }
    if (proposal.frontmatter && decision.frontmatter) {
      const { tags, summary } = proposal.frontmatter;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        (fm as Record<string, unknown>).tags = tags;
        if (summary) (fm as Record<string, unknown>).summary = summary;
      });
    }
    if (proposal.rename && decision.rename) {
      await this.app.fileManager.renameFile(file, proposal.rename.to);
    }
  }

  /**
   * Folder right-click "Organize notes into subfolders": batch-infer a
   * subfolder per note from titles/summaries, review the proposed move plan,
   * then execute the accepted subset.
   */
  private async organizeFolderFlow(folder: TFolder): Promise<void> {
    const files = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    if (files.length === 0) {
      new Notice(`No notes directly in ${folder.path}/.`);
      return;
    }
    const progress = new Notice(`Proposing a layout for ${files.length} note${files.length === 1 ? "" : "s"}…`, 0);
    try {
      const candidates: OrganizeCandidate[] = [];
      const titles = new Map<string, string>();
      for (const file of files) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        const title = typeof fm?.title === "string" && fm.title.trim() ? fm.title.trim() : file.basename;
        let summary = typeof fm?.summary === "string" ? fm.summary.trim() : "";
        if (!summary) {
          const body = stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
          summary = body.slice(0, 200);
        }
        titles.set(file.path, title);
        candidates.push({ path: file.path, title, summary });
      }

      const existingFolders = folder.children
        .filter((c): c is TFolder => c instanceof TFolder)
        .map((c) => c.name)
        .sort();
      let proposals = candidates.map((c) => ({ path: c.path, domain: "misc" }));
      try {
        const { system, user } = buildFolderOrganizePrompt(candidates, existingFolders);
        const raw = (
          await this.router().complete("utility", {
            system,
            user,
            maxTokens: 2048,
            responseFormat: "json",
            thinking: { type: "disabled" },
          })
        ).text;
        proposals = parseOrganizeResponse(raw, candidates);
      } catch (e) {
        if (e instanceof UtilityUnavailableError) throw e;
        // Inference failed — the review modal still offers the misc move.
      }

      const moves = planOrganizeMoves(proposals, titles, {
        baseFolder: folder.path,
        taken: (p) => this.app.vault.getAbstractFileByPath(p) !== null,
      });
      if (moves.length === 0) {
        new Notice("Everything is already named and filed.");
        return;
      }
      new OrganizeReviewModal(this.app, moves, (accepted) => {
        if (!accepted || accepted.length === 0) return;
        void (async () => {
          let moved = 0;
          for (const move of accepted) {
            const file = this.app.vault.getAbstractFileByPath(move.from);
            if (!(file instanceof TFile)) continue;
            const dir = move.to.slice(0, move.to.lastIndexOf("/"));
            await ensureVaultFolder(this.app, dir);
            await this.app.fileManager.renameFile(file, move.to);
            moved++;
          }
          new Notice(`Organized ${moved} note${moved === 1 ? "" : "s"} into ${folder.path}/ subfolders.`);
        })();
      }).open();
    } catch (e) {
      new Notice(`Organize failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.hide();
    }
  }

  /** Configured Zotero library for zotero_key import resolution; undefined until a user id is set. */
  private zoteroLibrary(): ZoteroLibrary | undefined {
    const userId = this.settings.zoteroUserId.trim();
    if (!userId) return undefined;
    const apiKey = this.settings.zoteroApiKey.trim();
    return { userId, ...(apiKey ? { apiKey } : {}) };
  }

  /** Vault tools for the in-chat agent loop, options refreshed from settings on every call. */
  agentTools(): VaultTools {
    const opts = {
      allowWrites: this.settings.agentAllowWrites,
      defaultFolder: this.settings.mcpWriteFolder,
      semantic: (q: string, k: number, accept?: (path: string) => boolean) => this.semanticSearch(q, k, accept),
      related: async (p: string, k: number) => {
        if (!this.settings.semanticEnabled) throw new Error(SEMANTIC_OFF_MESSAGE);
        return this.relatedForTools(p, k);
      },
      ontology: () => this.ontology(),
      ontologyFolder: () => this.settings.ontologyFolder,
      zotero: () => this.zoteroLibrary(),
      ...this.webToolImpls(),
    };
    if (!this.agentVaultTools) this.agentVaultTools = new VaultTools(this.app, opts);
    else this.agentVaultTools.setOptions(opts);
    return this.agentVaultTools;
  }

  /** Desktop only: the Node ports for the Claude Code backend. Tests override this. */
  cliRuntime(): ClaudeCliRuntime | null {
    if (this._cliRuntime !== undefined) return this._cliRuntime;
    if (Platform.isMobile || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
      this._cliRuntime = null;
      return null;
    }
    this._cliRuntime = createNodeCliRuntime();
    return this._cliRuntime;
  }

  private async createChatBridge(binding: { deps: InteractiveToolDeps; readOnly: boolean; tools: boolean }): Promise<{ server: McpHttpServer; port: number; token: string }> {
    const { McpHttpServer } = await import("./mcp/server");
    const token = generateToken();
    const registry = interactiveTools(this.agentTools(), () => binding.deps, () => binding.readOnly, () => binding.tools);
    const server = new McpHttpServer(
      {
        port: 0,
        token,
        serverInfo: { name: "obsidian-vault", version: "0.2.0" },
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

  async cliTurnRunner(opts: { conversationId: string; planMode: boolean; agentMode: boolean; model: string; deps: InteractiveToolDeps; transcript: string; resumeSessionId?: string }): Promise<AgentTurnRunner> {
    const cli = this.router().claudeCli;
    const executable = cli.executable();
    if (!executable) throw new Error(cli.probe() ? "Claude Code is not signed in. Run `claude auth login` in a terminal." : "Claude Code not found.");
    const runtime = this.cliRuntime();
    const cwd = this.vaultBasePath();
    if (!runtime || !cwd) throw new Error("Claude Code runs on desktop only.");
    const allowedTools = opts.agentMode ? cliAllowedTools(this.agentTools().definitions(), opts.planMode) : [];
    const signature = JSON.stringify({ model: opts.model, planMode: opts.planMode, agentMode: opts.agentMode, allowedTools, writes: this.settings.agentAllowWrites });
    const existing = this.cliSessions.get(opts.conversationId);
    if (!opts.resumeSessionId && existing && existing.signature === signature && !existing.session.isClosed()) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    if (existing) await this.closeCliSession(opts.conversationId);
    while (this.cliSessions.size >= 3) {
      const oldest = [...this.cliSessions.entries()].filter(([, e]) => !e.session.isBusy()).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      await this.closeCliSession(oldest[0]);
    }
    const promptFile = await runtime.writeSystemPromptFile(this.composeSystemPrompt({ agent: true, plan: opts.planMode }));
    this.cliPromptFiles.add(promptFile);
    let bridge: McpHttpServer | null = null;
    try {
      const started = await this.createChatBridge({ deps: opts.deps, readOnly: opts.planMode, tools: opts.agentMode });
      bridge = started.server;
      const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
      const argv = buildClaudeArgv({
        model: opts.model,
        systemPromptFile: promptFile,
        mcpConfigJson: mcpConfigJson(started.port, started.token),
        allowedTools,
        maxTurns: this.settings.agentMaxIterations,
        ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : { sessionId }),
      });
      const session = new ClaudeCliSession({ spawn: () => runtime.spawn(executable, argv, cwd), ...(opts.transcript ? { transcript: opts.transcript } : {}) });
      this.cliSessions.set(opts.conversationId, { session, bridge, signature, promptFile, lastUsed: Date.now() });
      await this.setConversationCliSession(opts.conversationId, sessionId);
      return session;
    } catch (error) {
      this.cliSessions.delete(opts.conversationId);
      await bridge?.stop();
      await runtime.removeFile(promptFile);
      this.cliPromptFiles.delete(promptFile);
      throw error;
    }
  }

  interruptCliTurn(conversationId: string): void {
    this.cliSessions.get(conversationId)?.session.interrupt();
  }

  private async closeCliSession(conversationId: string): Promise<void> {
    const entry = this.cliSessions.get(conversationId);
    if (!entry) return;
    this.cliSessions.delete(conversationId);
    await entry.session.close();
    await entry.bridge.stop();
    await this.cliRuntime()?.removeFile(entry.promptFile);
    this.cliPromptFiles.delete(entry.promptFile);
  }

  async closeCliSessions(): Promise<void> {
    for (const id of [...(this.cliSessions?.keys() ?? [])]) await this.closeCliSession(id);
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

  /**
   * The agent's web tools, built from settings on every call. Each fires only
   * on an explicit model tool call — nothing searches or fetches in the
   * background. DOMParser-less environments (headless tests) get no tools.
   */
  private webToolImpls(): Pick<VaultToolsOptions, "webSearch" | "webFetch"> {
    const s = this.settings;
    const out: { webSearch?: (query: string, count: number) => Promise<string>; webFetch?: (url: string) => Promise<string> } = {};
    if (s.webSearchEnabled) {
      out.webSearch = async (query, count) => {
        if (s.webSearchEngine === "brave") {
          if (!s.braveSearchApiKey.trim()) {
            throw new Error("Brave Search needs an API key — add it in Companion settings → Agent, or switch to DuckDuckGo.");
          }
          return formatSearchResults(query, await braveSearch(createObsidianDiscoveryHttp(), s.braveSearchApiKey, query, count));
        }
        if (typeof DOMParser === "undefined") throw new Error("Web search is unavailable in this environment.");
        return formatSearchResults(
          query,
          await duckDuckGoSearch(
            {
              fetchHtml: async (url) => {
                const response = await requestUrl({ url, method: "GET", throw: false });
                if (response.status >= 400) throw new Error(`Search failed (${response.status}).`);
                return response.text;
              },
              parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
            },
            query,
            count,
          ),
        );
      };
    }
    if (s.webFetchEnabled && typeof DOMParser !== "undefined") {
      out.webFetch = (url) =>
        webFetchPage(url, {
          fetchHtml: async (target) => {
            const response = await requestUrl({ url: target, method: "GET", throw: false });
            if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
            return response.text;
          },
          parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
        });
    }
    return out;
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

  // ---------- semantic index (local embeddings) ----------

  indexer(): SemanticIndexer | null { return this.semantic().indexer(); }
  async promptSemanticModelIfNeeded(): Promise<void> { return this.semantic().promptSemanticModelIfNeeded(); }
  private async downloadBuiltinModelAndIndex(): Promise<void> { return this.semantic().downloadBuiltinModelAndIndex(); }
  invalidateIndexer(): void { this.semantic().invalidateIndexer(); }
  async semanticSearch(query: string, k: number, accept?: (path: string) => boolean): Promise<{ path: string; text: string }[]> { return this.semantic().semanticSearch(query, k, accept); }
  async relatedNotes(path: string, k: number): Promise<{ path: string; score: number }[]> { return this.semantic().relatedNotes(path, k); }
  async relatedForTools(path: string, k: number, accept?: (path: string) => boolean): Promise<{ path: string; score: number }[]> { return this.semantic().relatedForTools(path, k, accept); }
  async rebuildSemanticIndex(): Promise<void> { return this.semantic().rebuildSemanticIndex(); }
  async showSemanticIndexStatus(): Promise<void> { return this.semantic().showSemanticIndexStatus(); }
  private queueReindex(path: string): void { this.semantic().queueReindex(path); }
  suspendReindex(): () => void { return this.semantic().suspendReindex(); }
  private async canEmbedWithoutDownload(): Promise<boolean> { return this.semantic().canEmbedWithoutDownload(); }

  // ---------- view ----------

  async activateView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null;
    if (Platform.isMobile) {
      // Mobile's right split is a drawer, not the full-width main workspace.
      // Reuse only a Chat leaf outside that drawer so repeated activation keeps
      // the same conversation without accumulating duplicate main tabs.
      const rightSplit = workspace.rightSplit;
      leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE).find((candidate) => {
        let parent: unknown = candidate.parent;
        while (parent) {
          if (parent === rightSplit) return false;
          parent = (parent as { parent?: unknown }).parent;
        }
        return true;
      }) ?? null;
      if (!leaf) {
        leaf = workspace.getLeaf("tab");
        await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      }
    } else {
      leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
      if (!leaf) {
        leaf = workspace.getRightLeaf(false);
        if (leaf) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      await workspace.revealLeaf(leaf);
      return leaf.view instanceof ChatView ? leaf.view : null;
    }
    return null;
  }

  async companionWorkspaceContext(): Promise<CompanionWorkspaceCard | null> {
    const active = this.app.workspace.getActiveFile();
    if (!(active instanceof TFile) || active.extension !== "md") return null;
    const frontmatter = this.app.metadataCache.getFileCache(active)?.frontmatter as Record<string, unknown> | undefined;
    const projectPath = inferResearchProjectPath(active.path, frontmatter);
    if (projectPath) {
      try {
        const snapshot = await this.researchRepository().loadProject(projectPath);
        const vm = buildResearchDeskViewModel(snapshot, auditProject(snapshot), this.researchDeskPreferences[projectPath] ?? { dismissedActionIds: [] });
        return resolveCompanionWorkspace({
          activeNote: { path: active.path, title: active.basename },
          research: {
            projectPath,
            title: vm.title,
            stage: vm.stage.current,
            ...(vm.nextAction ? { nextAction: vm.nextAction.label, nextReason: vm.nextAction.reason } : {}),
          },
        });
      } catch (e) { console.debug("Claude Companion: research workspace resolution failed, using active note", e); }
    }
    return resolveCompanionWorkspace({ activeNote: { path: active.path, title: active.basename } });
  }

  async askCompanionAboutProject(projectPath: string): Promise<void> {
    const view = await this.activateView();
    view?.prepareWorkspaceQuestion({ kind: "research", title: "Continue this research project", contextPath: projectPath });
  }

  // ---------- session memory ----------

  /** Absolute path of the current vault, or null if not a desktop file vault. */
  private vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  async listVaultSessions(): Promise<SessionMeta[]> {
    return this.memory().listVaultSessions();
  }

  /** Open the workflows picker; run the chosen workflow in the chat. */
  async openWorkflowPicker(): Promise<void> {
    new WorkflowPicker(this.app, WORKFLOWS, (wf) => void this.runWorkflow(wf)).open();
  }

  /** Run a vault workflow: ground it (active note + vault search), send its prompt. */
  async runWorkflow(wf: Workflow): Promise<void> {
    this.settings.context.activeNote = true;
    if (wf.vaultSearch) this.settings.context.searchVault = true;
    await this.saveSettings();
    const view = await this.activateView();
    if (!view) return;
    // Workflows produce large artifacts — give them output-token headroom.
    await view.submitPrompt(wf.prompt, wf.name, ARTIFACT_MAX_TOKENS);
  }

  async openSessionPicker(): Promise<void> {
    return this.memory().openSessionPicker();
  }

  async captureSession(session: SessionMeta): Promise<void> {
    return this.memory().captureSession(session);
  }

  async consolidateMemory(opts?: { quiet?: boolean }): Promise<void> {
    return this.memory().consolidateMemory(opts);
  }

  async captureLatestSession(): Promise<void> {
    return this.memory().captureLatestSession();
  }

  async captureConversation(messages: ChatMessage[]): Promise<void> {
    return this.memory().captureConversation(messages);
  }

  async reingestSession(sessionId: string): Promise<void> {
    return this.memory().reingestSession(sessionId);
  }

  async activateMemoryView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(MEMORY_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: MEMORY_VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  async activateInboxView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  /** Inbox-view entry point: guard + consent + enrich, then refresh open inbox views. */
  async enrichInboxItem(file: TFile, options?: { inline?: boolean; refreshInboxViews?: boolean }): Promise<EnrichRunOutcome> {
    const outcome = await this.enrichment().enrichFile(file, !options?.inline);
    if (options?.refreshInboxViews === false) return outcome;
    for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) {
      if (leaf.view instanceof InboxView) {
        try {
          await leaf.view.render();
        } catch (error) {
          console.warn("[companion] Inbox refresh failed", error);
        }
      }
    }
    return outcome;
  }

  /** Unenriched inbox files right now (drives the ribbon badge). */
  private inboxPendingCount(): number {
    const entries = this.app.vault.getFiles().map((f: TFile) => ({
      path: f.path,
      basename: f.basename,
      ext: f.extension,
      frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter ?? undefined,
    }));
    return inboxItems(entries, this.settings.sourceInboxFolder).length;
  }

  private scheduleInboxBadgeSync(): void {
    if (this.inboxBadgeTimer !== null) window.clearTimeout(this.inboxBadgeTimer);
    this.inboxBadgeTimer = window.setTimeout(() => {
      this.inboxBadgeTimer = null;
      this.syncInboxBadge();
    }, 800);
  }

  private syncInboxBadge(): void {
    const el = this.inboxRibbonEl;
    if (!el) return;
    const n = this.settings.sourceCaptureEnabled ? this.inboxPendingCount() : 0;
    el.setAttr("aria-label", n > 0 ? `Source inbox — ${n} to type` : "Source inbox");
    let badge = el.querySelector<HTMLElement>(".cc-inbox-ribbon-badge");
    if (n > 0) {
      if (!badge) badge = el.createSpan({ cls: "cc-inbox-ribbon-badge" });
      badge.setText(String(n));
    } else {
      badge?.remove();
    }
  }

  private async refreshMemoryView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(MEMORY_VIEW_TYPE)) {
      if (leaf.view instanceof MemoryView) await leaf.view.render();
    }
  }

  async activateRelatedView(): Promise<void> {
    if (!this.settings.semanticEnabled) {
      new Notice("Turn on semantic search in Companion settings to use related notes.");
    }
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(RELATED_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: RELATED_VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  async activateResearchDesk(projectPath?: string): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    const frontmatter = active ? this.app.metadataCache.getFileCache(active)?.frontmatter as Record<string, unknown> | undefined : undefined;
    const inferred = active ? inferResearchProjectPath(active.path, frontmatter) : undefined;
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(RESEARCH_DESK_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      if (leaf) await leaf.setViewState({ type: RESEARCH_DESK_VIEW_TYPE, active: true });
    }
    if (leaf?.view instanceof ResearchDeskView) {
      const selected = leaf.view.getProjectPath();
      const next = projectPathForActivation(projectPath, inferred, selected);
      if (next && next !== selected) await leaf.view.setProjectPath(next);
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  async activateResearchWorkbench(projectPath?: string, tab: ResearchWorkbenchTab = "Overview", path?: string): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    const frontmatter = active ? this.app.metadataCache.getFileCache(active)?.frontmatter as Record<string, unknown> | undefined : undefined;
    const inferred = active ? inferResearchProjectPath(active.path, frontmatter) : undefined;
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(RESEARCH_WORKBENCH_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      if (leaf) await leaf.setViewState({ type: RESEARCH_WORKBENCH_VIEW_TYPE, active: true });
    }
    if (leaf?.view instanceof ResearchWorkbenchView) {
      const selected = leaf.view.getProjectPath();
      const next = projectPathForActivation(projectPath, inferred, selected);
      if (next && next !== selected) await leaf.view.setProjectPath(next);
      await leaf.view.focus(tab, path);
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  private scheduleResearchRefresh(path: string, oldPath?: string): void {
    this.researchRefreshChanges.push({ path, ...(oldPath ? { oldPath } : {}) });
    if (this.researchRefreshTimer !== null) window.clearTimeout(this.researchRefreshTimer);
    this.researchRefreshTimer = window.setTimeout(() => {
      this.researchRefreshTimer = null;
      const changes = this.researchRefreshChanges;
      this.researchRefreshChanges = [];
      for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_WORKBENCH_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof ResearchWorkbenchView && changes.some(({ path, oldPath }) => view.isRelevantChange(path, oldPath))) void view.render();
      }
      for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_DESK_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof ResearchDeskView && changes.some(({ path, oldPath }) => isResearchProjectChange(view.getProjectPath(), path, oldPath))) void view.render();
      }
    }, 250);
  }

  private researchRepository(): ResearchRepository {
    return createResearchRepository(this.app, {
      ensureFolder: (folder) => ensureVaultFolder(this.app, folder),
      includeBinary: true,
    });
  }

  // ---------- command helpers ----------

  async generatePlanFromNote(): Promise<void> {
    this.settings.context.activeNote = true;
    await this.saveSettings();
    const view = await this.activateView();
    if (!view) return;
    await view.submitPrompt(
      `${PLANNING_INSTRUCTION}\n\nBase the plan entirely on the content of my current note.`,
      "Generate an implementation plan from this note",
      ARTIFACT_MAX_TOKENS,
    );
  }

  /**
   * "/frontmatter": propose type / tags / summary for the ACTIVE note using the
   * utility model (reusing the vault's existing tags), preview it, and apply it
   * additively via processFrontMatter. Never clobbers fields the user already set
   * — tags union, scalar fields only filled when absent.
   */
  async suggestFrontmatterForActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Open a note to suggest frontmatter for.");
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    if (content.trim().length === 0) {
      new Notice("This note is empty — nothing to describe.");
      return;
    }

    const existingTags = existingVaultTags(this.app);
    const typeOptions = this.settings.ontologyEnabled ? [...(this.ontology()?.resolved().keys() ?? [])] : [];
    const notice = new Notice("Suggesting frontmatter…", 0);
    try {
      const existingLine = existingTags.length > 0 ? `Existing tags (prefer these when relevant): ${existingTags.join(", ")}\n\n` : "";
      const body = content.length > 8000 ? content.slice(0, 8000) + "\n…[truncated]" : content;
      const { text: raw, provider } = await this.router().complete("utility", {
        system: frontmatterSuggestSystem(typeOptions),
        user: `${existingLine}Document:\n\n${body}`,
        maxTokens: 200,
      });
      const suggestion = parseFrontmatterSuggestion(raw);

      // Merge additively against what's already in the note's frontmatter.
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      const currentTags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === "string" ? [fm.tags] : [];
      const proposal = {
        ...(suggestion.type && !fm.type ? { type: suggestion.type } : {}),
        tags: normalizeTags([...currentTags, ...suggestion.tags]),
        ...(suggestion.summary && !fm.summary ? { summary: suggestion.summary } : {}),
      };
      notice.hide();

      new FrontmatterModal(this.app, file.basename, proposal, provider.label, async (apply) => {
        if (!apply) return;
        await this.app.fileManager.processFrontMatter(file, (f) => {
          const rec = f as Record<string, unknown>;
          if (proposal.type && !rec.type) rec.type = proposal.type;
          rec.tags = proposal.tags;
          if (proposal.summary && !rec.summary) rec.summary = proposal.summary;
        });
        new Notice(`Frontmatter updated: ${file.basename}`);
      }).open();
    } catch (e) {
      notice.hide();
      new Notice(`Couldn't suggest frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async handoffToBuild(planFile?: TFile): Promise<void> {
    const file = planFile ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    const runId = await this.build().handoffToBuild(
      file instanceof TFile ? { path: file.path, basename: file.basename } : null,
    );
    if (runId) await this.activateBuildView(runId);
  }

  activeBuildRun(): BuildRun | null {
    return this.build().activeBuildRun();
  }

  async activateBuildView(runId?: string): Promise<BuildView | null> {
    if (runId) this.build().selectActiveRun(runId);
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(BUILD_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: BUILD_VIEW_TYPE, active: true });
    }
    if (leaf) {
      await workspace.revealLeaf(leaf);
      const run = this.activeBuildRun();
      if (run && leaf.view instanceof BuildView) leaf.view.setRun(run);
      return leaf.view instanceof BuildView ? leaf.view : null;
    }
    return null;
  }

  // ---------- cloud session dispatch ----------

  private _cloud?: CloudController;
  private cloud(): CloudController {
    return (this._cloud ??= new CloudController({
      settings: () => this.settings,
      http: async (req) => {
        const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, ...(req.body ? { body: req.body } : {}), throw: false });
        return { status: res.status, text: res.text };
      },
      vault: {
        fileExists: (path) => !!this.app.vault.getAbstractFileByPath(path),
        create: async (path, content) => { await this.app.vault.create(path, content); },
        ensureFolder: (folder) => ensureVaultFolder(this.app, folder),
        normalizePath,
      },
      ui: {
        notice: (msg, timeout) => new Notice(msg, timeout),
        clipboard: (text) => navigator.clipboard.writeText(text),
        activeSelection: () => {
          const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
          return { path: mdView?.file?.path, selection: mdView?.editor.getSelection().trim() || undefined };
        },
        promptInstruction: (context, onSubmit) => new CloudDispatchModal(this.app, context, onSubmit).open(),
      },
    }));
  }

  async dispatchCloudSession(): Promise<void> {
    return this.cloud().dispatchSession();
  }

  async testCloudReplies(): Promise<{ ok: boolean; message: string }> {
    return this.cloud().testReplies();
  }

  async pullCloudReplies(): Promise<void> {
    return this.cloud().pullReplies();
  }

  async generateArtifactFromContext(): Promise<void> {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const hasSelection = !!mdView?.editor.getSelection().trim();
    this.settings.context.activeNote = true;
    this.settings.context.selection = true;
    await this.saveSettings();
    const view = await this.activateView();
    if (!view) return;
    const target = hasSelection ? "the selected text" : "my current note";
    await view.submitPrompt(
      `Turn ${target} into a single beautiful, self-contained interactive artifact (a \`\`\`claude-html block) using the design system. Choose the best format (plan, report, table, diagram, or dashboard) for the content.`,
      `Turn ${target} into an artifact`,
      ARTIFACT_MAX_TOKENS,
    );
  }
}
