import { ItemView, MarkdownRenderer, MarkdownView, Notice, Platform, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import type { ChatMessage, ContextToggles } from "../types";
import { providerTurnRunner, type AgentTurnDeps, type AgentTurnHandlers, type AgentTurnResult, type AgentTurnRunner } from "../agent/loop";
import { toAnthropicTools, executeTool, readOnlyAnthropicTools, PROPOSE_EDIT_TOOL, truncateResult } from "../agent/tools";
import { parseExternalToolName } from "../mcp/external";
import { WriteConfirmModal } from "./WriteConfirmModal";
import { planEdits, applyPlan, type ProposedEdit } from "../edit/diff";
import { reviewEdits } from "../editor/reviewEdits";
import type { ApiMessage, ToolResultBlock, ToolUseBlock, Provider } from "../providers/types";
import { TFile } from "obsidian";
import { compactArtifactsInHistory, compactMessages, toApiMessages, transcriptText, type Conversation } from "../conversations/store";
import { resolveModelId } from "../claude/models";
import { type ChatControls, defaultChatControls, shapeRequest } from "../claude/chatControls";
import { shouldFallbackToLocal, fallbackReason } from "../providers/fallback";
import type { CompletionRequest } from "../providers/types";
import { SlashMenu } from "./SlashMenu";
import type { ChatMode } from "./ModeControl";
import { skillSlashCommands, workflowSlashCommands, SLASH_COMMANDS, type SlashCommand, runNativeSlashCommand, templateSlashCommand, WORKFLOW_ACTION_PREFIX, SKILL_ACTION_PREFIX } from "./slashCommands";
import { substitutePlaceholders } from "../templates/promptTemplates";
import { type AttachedPage } from "../context/urlContext";
import { WORKFLOWS } from "../workflows/catalog";
import { SKILLS } from "../workflows/skillRegistry.generated";
import { composeSkillPrompt, parseSkillInvocation, skillDisplay } from "../skills/compose";
import { splitStreamingArtifact } from "./streamRender";
import { gatherContext, type AttachedPath } from "../context/vaultContext";
import { type MediaAttachment } from "../context/attachments";
import { type AtItem, type ClaimAtSource } from "../context/atMention";
import { isProjectChange, projectSearchScope, type ChatProject } from "../projects/model";
import { type ErrorHintProvider } from "../providers/errorHints";
import { needsCredentialSetup } from "../providers/setupState";
import { claudeBackend } from "../cli/backends/claude";
import { codexBackend } from "../cli/backends/codex";
import { opencodeBackend } from "../cli/backends/opencode";
import type { CliBackend, CliSignInProvider } from "../cli/backends/types";
import type { ProviderRouter } from "../providers/router";
import { EMPTY_SESSION, type SessionUsage } from "../usage/tokens";
import { type TokenUsage } from "../claude/sse";
import type { CompanionWorkspaceCard } from "./companionWorkspace";
import { quickNotice } from "../notice";
import { ComposerContextManager } from "./ComposerContextManager";
import { type AutomaticContextKey } from "./contextManagerModel";
import { HeaderControls } from "./chat/HeaderControls";
import { Composer } from "./chat/Composer";
import { Transcript, type TurnState } from "./chat/Transcript";
import { SetupCard } from "./chat/SetupCard";

export const CHAT_VIEW_TYPE = "claude-companion-chat";

/** The message list a turn should persist as: `base` plus the assistant reply, when one was produced. */
function appendAssistantMessage(base: ChatMessage[], result: AgentTurnResult): ChatMessage[] {
  const full = result.text.trim();
  if (!full) return base;
  return [...base, { role: "assistant", content: result.text, ...(result.trace.length > 0 ? { toolTrace: result.trace } : {}) }];
}

/** Tag which provider a fallback-ineligible error actually failed on, for renderError's hint. */
function tagProvider(error: Error | undefined, provider: ErrorHintProvider): void {
  if (error) (error as Error & { ccProvider?: ErrorHintProvider }).ccProvider = provider;
}

/** Defensive shape-check of a propose_note_edit `edits` argument. */
function parseProposedEdits(v: unknown): ProposedEdit[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error("propose_note_edit requires a non-empty 'edits' array.");
  return v.map((e, i) => {
    const o = e as { old_str?: unknown; new_str?: unknown };
    if (typeof o?.old_str !== "string" || typeof o?.new_str !== "string") {
      throw new Error(`edits[${i}] must have string 'old_str' and 'new_str'.`);
    }
    return { old_str: o.old_str, new_str: o.new_str };
  });
}

interface ObsidianAppWithSettings {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
  commands?: { executeCommandById?: (id: string) => boolean };
}

export class ChatView extends ItemView {
  private header: HeaderControls;
  private get modelLabelEl(): HTMLElement { return this.header.modelLabelEl; }
  private set modelLabelEl(v: HTMLElement) { this.header.modelLabelEl = v; }
  private composer: Composer;
  private messages: ChatMessage[] = [];
  private transcript: Transcript;
  private setupCard: SetupCard;
  private get messagesEl(): HTMLElement { return this.transcript.messagesEl; }
  private set messagesEl(v: HTMLElement) { this.transcript.messagesEl = v; }
  private get inputEl(): HTMLTextAreaElement { return this.composer.inputEl; }
  private set inputEl(v: HTMLTextAreaElement) { this.composer.inputEl = v; }
  private get sendBtn(): HTMLButtonElement { return this.composer.sendBtn; }
  private set sendBtn(v: HTMLButtonElement) { this.composer.sendBtn = v; }
  private get usageEl(): HTMLElement { return this.header.usageEl; }
  private set usageEl(v: HTMLElement) { this.header.usageEl = v; }
  private get gaugeFillEl(): HTMLElement { return this.header.gaugeFillEl; }
  private set gaugeFillEl(v: HTMLElement) { this.header.gaugeFillEl = v; }
  private streaming = false;
  /** Turn/session state shared with Transcript. */
  private readonly turn: TurnState = { lastBuffer: "", turnUsage: null, abort: null, currentTurn: null, session: { ...EMPTY_SESSION }, turnRenderUnsubscribe: null, unregisterCurrentTurn: null };
  private get abort(): AbortController | null { return this.turn.abort; }
  private set abort(v: AbortController | null) { this.turn.abort = v; }
  private get currentTurn(): { conversationId: string; turnId: string } | null { return this.turn.currentTurn; }
  private set currentTurn(v: { conversationId: string; turnId: string } | null) { this.turn.currentTurn = v; }
  private get unregisterCurrentTurn(): (() => void) | null { return this.turn.unregisterCurrentTurn; }
  private set unregisterCurrentTurn(v: (() => void) | null) { this.turn.unregisterCurrentTurn = v; }
  /** Detaches this view from the live turn's event stream (does not stop the turn). */
  private get turnRenderUnsubscribe(): (() => void) | null { return this.turn.turnRenderUnsubscribe; }
  private set turnRenderUnsubscribe(v: (() => void) | null) { this.turn.turnRenderUnsubscribe = v; }
  private resumeCliSessionId: string | null = null;
  private get session(): SessionUsage { return this.turn.session; }
  private set session(v: SessionUsage) { this.turn.session = v; }
  /** Usage for the in-flight turn; folded into the session once on completion. */
  private get _turnUsage(): TokenUsage | null { return this.turn.turnUsage; }
  private set _turnUsage(v: TokenUsage | null) { this.turn.turnUsage = v; }
  /** Per-session chat controls (model, thinking, effort, temp, max). */
  private controls!: ChatControls;
  private get controlsEl(): HTMLElement { return this.composer.controlsEl; }
  private set controlsEl(v: HTMLElement) { this.composer.controlsEl = v; }
  private get contextManager(): ComposerContextManager { return this.composer.contextManager; }
  private set contextManager(v: ComposerContextManager) { this.composer.contextManager = v; }
  /** Notes/folders explicitly attached via "@" (session-scoped). */
  private get attachedPaths(): AttachedPath[] { return this.composer.attachedPaths; }
  private set attachedPaths(v: AttachedPath[]) { this.composer.attachedPaths = v; }
  /** PDFs/images attached via "@" or paste — cleared after the next send. */
  private get attachedMedia(): MediaAttachment[] { return this.composer.attachedMedia; }
  private set attachedMedia(v: MediaAttachment[]) { this.composer.attachedMedia = v; }
  /** Media consumed by the last send — restored on failure, re-sent on Regenerate. */
  private lastUserMedia: MediaAttachment[] = [];
  /** Per-turn max-output override (artifact/plan/workflow flows need headroom). */
  private maxTokensOverride: number | null = null;
  private contextStatusInterval: number | null = null;
  /** Last visible context-manager state; skip DOM rebuilds when nothing changed. */
  private get lastContextManagerSignature(): string { return this.composer.lastContextManagerSignature; }
  private set lastContextManagerSignature(v: string) { this.composer.lastContextManagerSignature = v; }
  private lastMarkdownView: MarkdownView | null = null;
  private lastMarkdownFilePath: string | null = null;
  /** The last user message text, for the Regenerate action. */
  private lastUserText = "";
  /** The last user-bubble display text, when it differs from lastUserText (skill turns). */
  private lastDisplay: string | undefined = undefined;
  private get slashMenu(): SlashMenu { return this.composer.slashMenu; }
  private set slashMenu(v: SlashMenu) { this.composer.slashMenu = v; }
  /** User-defined prompt templates (notes in the templates folder). */
  private templateCommands: SlashCommand[] = [];
  private templateReloadGeneration = 0;
  /** Research claims offered by the "@"/"#" pickers, refreshed when a research note changes. */
  private cachedClaims: ClaimAtSource[] = [];
  private claimReloadGeneration = 0;
  private claimReloadTimer: number | null = null;
  /** Chat projects offered by the "@" picker, refreshed alongside claims. */
  private cachedProjects: ChatProject[] = [];
  /** The chat project this.conversationId is scoped to (null = none), kept in sync with the conversation. */
  private currentChatProject: ChatProject | null = null;
  /** A project chosen before the first send (no conversation yet); applied once `run()` creates one. */
  private pendingProjectId: string | null = null;
  /** Which trigger ("@" or "#") the open at-menu is currently showing matches for. */
  private get activeMenuTrigger(): "@" | "#" { return this.composer.activeMenuTrigger; }
  private set activeMenuTrigger(v: "@" | "#") { this.composer.activeMenuTrigger = v; }
  /** Per-turn overrides from a prompt template; reset at the start of each run. */
  private turnModelOverride: string | null = null;
  private turnContextOverride: Partial<ContextToggles> | null = null;
  /** Web pages attached via "Attach page content" (captured markdown). */
  private get attachedPages(): AttachedPage[] { return this.composer.attachedPages; }
  private set attachedPages(v: AttachedPage[]) { this.composer.attachedPages = v; }
  /** Latest streamed text of the in-flight turn (for clean abort handling). */
  private get _lastBuffer(): string { return this.turn.lastBuffer; }
  private set _lastBuffer(v: string) { this.turn.lastBuffer = v; }
  /** "Allow for this session" on agent write confirmations (cleared with the view). */
  private agentWriteAlways = false;
  /** Plan Mode: read-only agent turn that ends in a plan (per conversation). */
  private planMode = false;
  /** Whether the current chat backend can run tool-driven agent turns (refreshed per turn + backend change). */
  private agentCapable = false;
  /** Guards the setup card's background sign-in probe against stacking on re-render, per CLI backend id. */

  private renderVersions = new WeakMap<HTMLElement, number>();
  /** The conversation this leaf shows; null for an unstarted "New chat tab". Persisted via getState/setState. */
  private conversationId: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ClaudeCompanionPlugin,
  ) {
    super(leaf);
    this.setupCard = new SetupCard({
      plugin,
      cliEntries: (router) => this.cliEntries(router),
      messagesEl: () => this.messagesEl,
      hasMessages: () => this.messages.length > 0,
      renderEmptyState: () => this.renderEmptyState(),
      refreshModelLabel: () => this.refreshModelLabel(),
      openSettings: () => this.openSettings(),
    });
    this.transcript = new Transcript(this.app, plugin, this.turn, {
      autosizeInput: () => this.composer.autosizeInput(),
      onSend: (...args) => this.onSend(...args),
      prepareWorkspaceQuestion: (...args) => this.prepareWorkspaceQuestion(...args),
      regenerate: (...args) => this.regenerate(...args),
      renderMarkdownInto: (...args) => this.renderMarkdownInto(...args),
      renderSetupCard: (parent) => this.setupCard.render(parent),
      renderStreamingArtifactInto: (...args) => this.renderStreamingArtifactInto(...args),
      resumeInterruptedTurn: (...args) => this.resumeInterruptedTurn(...args),
      restoreMediaAfterFailure: (...args) => this.restoreMediaAfterFailure(...args),
      setSending: (...args) => this.setSending(...args),
      setupRequired: (...args) => this.setupRequired(...args),
      submitPrompt: (text, display) => this.submitPrompt(text, display),
      updateUsageBar: (...args) => this.updateUsageBar(...args),
      controls: () => this.controls,
      inputEl: () => this.composer.inputEl,
      lastUserText: () => this.lastUserText,
      messages: () => this.messages,
      streaming: () => this.streaming,
    });
    this.header = new HeaderControls(this.app, plugin, {
      anyContextEnabled: () => this.composer.anyContextEnabled(),
      applyMode: (...args) => this.applyMode(...args),
      clearChat: (...args) => this.clearChat(...args),
      cliEntries: (...args) => this.cliEntries(...args),
      loadConversation: (...args) => this.loadConversation(...args),
      openSettings: (...args) => this.openSettings(...args),
      renderContextManager: (...args) => this.renderContextManager(...args),
      renderKnobs: () => this.composer.renderKnobs(),
      renderKnobsInto: (parent) => this.composer.renderKnobsInto(parent),
      saveChat: (...args) => this.transcript.saveChat(...args),
      updateModeControl: (...args) => this.updateModeControl(...args),
      agentCapable: () => this.agentCapable,
      setAgentCapable: (v) => { this.agentCapable = v; },
      agentWriteAlways: () => this.agentWriteAlways,
      controls: () => this.controls,
      inputEl: () => this.composer.inputEl,
      messages: () => this.messages,
      planMode: () => this.planMode,
      reasoningEl: () => this.composer.reasoningEl,
      session: () => this.session,
      currentProject: () => this.currentChatProject,
    });
    this.composer = new Composer(this.app, plugin, {
      applyChatFontSize: (...args) => this.applyChatFontSize(...args),
      applyMode: (...args) => this.applyMode(...args),
      currentMode: (...args) => this.currentMode(...args),
      onModelSelect: (...args) => this.header.onModelSelect(...args),
      refreshCapabilityIndicators: (...args) => this.header.refreshCapabilityIndicators(...args),
      registerDomEvent: (el, type, callback) => this.registerDomEvent(el, type, callback),
      resolveMarkdownContextView: (...args) => this.resolveMarkdownContextView(...args),
      updateModeControl: (...args) => this.updateModeControl(...args),
      updateUsageBar: (...args) => this.updateUsageBar(...args),
      cachedClaims: () => this.cachedClaims,
      cachedProjects: () => this.cachedProjects.map((p) => ({ id: p.id, name: p.name })),
      controls: () => this.controls,
      streaming: () => this.streaming,
      mountUsage: (parent) => this.header.mountUsage(parent),
      onSlashCommand: (cmd) => void this.runSlashCommand(cmd),
      pickAtItems: () => (this.activeMenuTrigger === "#" ? this.hashItems() : this.atItems()),
      onAtChoose: (item) => void this.onAtChoose(item),
      toggleAutomatic: (key, enabled) => this.toggleAutomaticContext(key, enabled),
      removeSource: (id) => this.removeContextSource(id),
      retrySource: (id) => this.retryContextSource(id),
      addContext: () => this.openContextPicker(),
      onSend: () => void this.onSend(),
      syncSlashMenu: () => this.syncSlashMenu(),
      chooseProject: (id) => this.chooseProjectById(id),
    });
  }

  override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  override getDisplayText(): string {
    const conversation = this.conversationId ? this.plugin.listConversations().find((c) => c.id === this.conversationId) : undefined;
    return conversation?.title ?? "Companion for Claude";
  }
  override getIcon(): string {
    return "sparkles";
  }

  override getState(): Record<string, unknown> {
    return { conversationId: this.conversationId };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const raw = (state as { conversationId?: unknown } | null)?.conversationId;
    if (raw === null) {
      // Explicit "start empty" signal (the New chat tab command) — overrides
      // whatever onOpen loaded by default for a freshly created leaf.
      this.conversationId = null;
      this.resetToEmpty();
    } else if (typeof raw === "string") {
      const conversation = this.plugin.listConversations().find((c) => c.id === raw);
      if (conversation) {
        this.conversationId = raw;
        this.loadConversation(conversation);
      }
      // An unknown id (e.g. a deleted conversation) keeps the current state.
    }
    await super.setState(state, result);
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    this.header.teardown();
    root.empty();
    root.addClass("cc-chat-root"); // scroll/layout root the mobile CSS keys on (see styles.css)
    root.addClass("cc-root");

    // Initialize per-session controls from the settings default model.
    if (!this.controls) {
      this.controls = defaultChatControls(resolveModelId(this.plugin.settings.model, this.plugin.settings.customModel));
    }

    // ---- header ----
    this.header.mount(root, {
      onModelClick: () => this.openModelMenu(),
      onMcpClick: (evt) => this.openMcpMenu(evt),
      onWriteGrantRevoke: () => {
        this.agentWriteAlways = false;
        this.header.updateWriteGrantPill();
        quickNotice("Session write grant revoked — writes will ask again.");
      },
      onNewChat: () => this.clearChat(),
      onHistory: () => this.openHistory(),
      onOverflow: () => this.openOverflowMenu(),
    });
    this.header.updateWriteGrantPill();

    // ---- messages ----
    // Chat controls now live at the bottom (in the composer), so the top stays
    // light and the reading area gets the space.
    this.messagesEl = root.createDiv({ cls: "cc-messages" });

    // ---- composer ----
    this.composer.mount(
      root,
      [...SLASH_COMMANDS, ...workflowSlashCommands(WORKFLOWS), ...skillSlashCommands(SKILLS, WORKFLOWS)],
    );
    this.renderContextManager();

    // User templates: load now, refresh when a note in the folder changes.
    void this.reloadTemplates();
    const templateTouched = (file: { path: string }): boolean =>
      file.path.startsWith(`${this.plugin.settings.templatesFolder.replace(/\/+$/, "")}/`);
    const scheduleTemplateReload = (file: { path: string }) => {
      if (templateTouched(file)) void this.reloadTemplates();
    };
    this.registerEvent(this.app.vault.on("create", scheduleTemplateReload));
    this.registerEvent(this.app.vault.on("modify", scheduleTemplateReload));
    this.registerEvent(this.app.vault.on("delete", scheduleTemplateReload));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (templateTouched(file) || templateTouched({ path: oldPath })) void this.reloadTemplates();
    }));

    // Research claims for the "@"/"#" pickers: load now, refresh on the same
    // signal the research views use to know a research note changed. Chat
    // projects reload alongside, but only for a chat-project note or a research Project.md.
    void this.reloadClaims();
    void this.reloadProjects();
    this.registerEvent(this.app.metadataCache.on("changed", (file) => { this.scheduleReloadClaims(); if (isProjectChange(file.path, this.app.metadataCache.getFileCache(file)?.frontmatter)) void this.reloadProjects(); }));
    this.registerEvent(this.app.vault.on("create", (file) => { if (file.path.endsWith(".md")) this.scheduleReloadClaims(); if (isProjectChange(file.path)) void this.reloadProjects(); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (file.path.endsWith(".md")) this.scheduleReloadClaims(); if (isProjectChange(file.path)) void this.reloadProjects(); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file.path.endsWith(".md") || oldPath.endsWith(".md")) this.scheduleReloadClaims(); if (isProjectChange(file.path) || isProjectChange(oldPath)) void this.reloadProjects(); }));

    this.applyChatFontSize();
    this.refreshModelLabel();
    void this.refreshBackendPill();
    void this.refreshContextStatus();
    if (this.contextStatusInterval !== null) window.clearInterval(this.contextStatusInterval);
    let tick = 0;
    this.contextStatusInterval = window.setInterval(() => {
      tick++;
      void this.refreshContextStatus();
      // The backend pill needs a network probe (localAvailable) — every ~10s
      // is fresh enough without hammering a dead host with 2s timeouts.
      if (tick % 5 === 0) void this.refreshBackendPill();
    }, 2000);
    // Resume the last active conversation if one was persisted; else empty state.
    const active = this.plugin.getActiveConversation();
    if (active && active.messages.length > 0) {
      this.loadConversation(active);
    } else {
      this.renderEmptyState();
    }
    this.updateUsageBar();
  }

  /** Replace the panel contents with a stored conversation and render it. */
  loadConversation(conversation: Conversation): void {
    this.detachTurnRendering();
    this.conversationId = conversation.id;
    this.pendingProjectId = null;
    void this.refreshCurrentProject();
    this.session = { ...EMPTY_SESSION };
    this.messages = compactMessages(conversation.messages);
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.renderEmptyState();
    } else {
      for (const m of this.messages) this.renderStoredMessage(m);
      const live = this.plugin.turnService().live(conversation.id);
      if (live) this.attachLiveTurn(conversation.id, live.turnId);
      else if (conversation.activeTurn) this.transcript.renderInterruptedTurn(conversation);
    }
    this.updateUsageBar();
    this.transcript.scrollToBottom();
    this.refreshTabTitle();
  }

  /** Ask Obsidian to re-read getDisplayText() so the tab header follows the active conversation's title. */
  private refreshTabTitle(): void {
    (this.leaf as { updateHeader?: () => void }).updateHeader?.();
  }

  /** Reattach to a turn already running elsewhere: replay its buffer, then stream live. */
  private attachLiveTurn(conversationId: string, turnId: string): void {
    this.currentTurn = { conversationId, turnId };
    this.setSending(true);
    this._turnUsage = null;
    const { bubble, body } = this.transcript.createAssistantBubble();
    const wantThinking = !!(this.controls?.thinking && this.controls?.showThinking);
    this.turnRenderUnsubscribe = this.transcript.startTurnRendering(conversationId, bubble, body, wantThinking, this.plugin.turnService());
  }

  /** Unsubscribe from the live turn's events without stopping it, and reset this view's send-state. */
  private detachTurnRendering(): void {
    this.turnRenderUnsubscribe?.();
    this.turnRenderUnsubscribe = null;
    this.unregisterCurrentTurn = null;
    this.currentTurn = null;
    this.abort = null;
    this.streaming = false;
    this.setSending(false);
  }

  private renderStoredMessage(m: ChatMessage): void { return this.transcript.renderStoredMessage(m); }

  /** Clear the panel to its empty state without altering stored history. */
  resetToEmpty(): void {
    this.detachTurnRendering();
    this.conversationId = null;
    this.pendingProjectId = null;
    this.messages = [];
    this.session = { ...EMPTY_SESSION };
    this.messagesEl.empty();
    this.renderEmptyState();
    this.updateUsageBar();
    this.refreshTabTitle();
  }

  openHistory(): void { return this.header.openHistory(); }

  private updateUsageBar(): void { return this.header.updateUsageBar(); }

  override async onClose(): Promise<void> {
    this.templateReloadGeneration++;
    this.claimReloadGeneration++;
    if (this.claimReloadTimer !== null) {
      window.clearTimeout(this.claimReloadTimer);
      this.claimReloadTimer = null;
    }
    this.header.teardown(false);
    // A live turn keeps running (and persisting) after the pane closes — only
    // detach this view from its event stream (ChatTurnService).
    this.detachTurnRendering();
    this.transcript.clearThinkingStatus();
    if (this.contextStatusInterval !== null) {
      window.clearInterval(this.contextStatusInterval);
      this.contextStatusInterval = null;
    }
    this.composer.destroy();
  }

  refreshModelLabel(): void { return this.header.refreshModelLabel(); }

  // ---------- public entry point (used by commands) ----------

  async submitPrompt(text: string, display?: string, maxTokens?: number, opts?: { model?: string; context?: Partial<ContextToggles> }): Promise<void> {
    if (!text.trim() || this.streaming) return;
    this.inputEl.value = "";
    await this.run(text.trim(), display, maxTokens, opts);
  }

  // ---------- "@" context picker ----------

  private atItems(): AtItem[] { return this.composer.atItems(); }

  private hashItems(): AtItem[] { return this.composer.hashItems(); }

  /** Coalesces rapid vault/metadata events into one reloadClaims() after the last one. */
  private scheduleReloadClaims(): void {
    if (this.claimReloadTimer !== null) window.clearTimeout(this.claimReloadTimer);
    this.claimReloadTimer = window.setTimeout(() => {
      this.claimReloadTimer = null;
      void this.reloadClaims();
    }, 500);
  }

  /** Re-read every active research project's claims for the "@"/"#" pickers. */
  private async reloadClaims(): Promise<void> {
    const generation = ++this.claimReloadGeneration;
    const claims: ClaimAtSource[] = [];
    try {
      const repo = this.plugin.researchRepository();
      const projects = (await repo.listProjects()).filter((p) => p.status === "active");
      for (const project of projects) {
        const snapshot = await repo.loadProject(project.path);
        for (const claim of snapshot.claims) claims.push({ path: claim.path, label: claim.proposition, project: claim.project });
      }
    } catch {
      // Research repository unavailable — claims stay empty.
    }
    if (generation !== this.claimReloadGeneration) return;
    this.cachedClaims = claims;
  }

  /** Re-read every available chat project (notes + Research Desk) for the "@" picker. */
  private async reloadProjects(): Promise<void> {
    try {
      this.cachedProjects = await this.plugin.listChatProjects();
    } catch {
      // Registry unavailable — projects list stays as it was.
    }
  }

  /** Set `currentChatProject` and its pill/header label, without touching persisted storage. */
  private setLocalProject(project: ChatProject | null): void {
    this.currentChatProject = project;
    this.composer.setProjectPill(project);
    this.header.setProjectLabel(project?.name ?? null);
  }

  /** Sync `currentChatProject` (and the pill/header label) to `this.conversationId`'s persisted projectId. */
  private async refreshCurrentProject(): Promise<void> {
    let project: ChatProject | null = null;
    try {
      project = await this.plugin.chatProjectFor(this.conversationId);
    } catch {
      // Conversation/registry lookup unavailable — no project for this turn.
    }
    this.setLocalProject(project);
  }

  /** Apply a project chosen from the "@" menu or the "Chat: choose project" command. */
  async applyChosenProject(project: ChatProject): Promise<void> {
    if (this.conversationId === null) {
      // No conversation yet — hold the choice until run() creates one.
      this.pendingProjectId = project.id;
      this.setLocalProject(project);
      return;
    }
    await this.plugin.setChatProject(this.conversationId, project.id);
    await this.refreshCurrentProject();
    this.updateUsageBar();
  }

  /** "@" project item / pill remove-×: `id` null clears the project. */
  private chooseProjectById(id: string | null): void {
    if (id === null) {
      void (async () => {
        if (this.conversationId) {
          await this.plugin.setChatProject(this.conversationId, null);
          await this.refreshCurrentProject();
        } else { this.pendingProjectId = null; this.setLocalProject(null); }
        this.updateUsageBar();
      })();
      return;
    }
    const project = this.cachedProjects.find((p) => p.id === id);
    if (project) void this.applyChosenProject(project);
  }

  private onAtChoose(item: AtItem): Promise<void> { return this.composer.onAtChoose(item); }

  private renderContextManager(): void { return this.composer.renderContextManager(); }

  private toggleAutomaticContext(key: AutomaticContextKey, enabled: boolean): void { return this.composer.toggleAutomaticContext(key, enabled); }

  private removeContextSource(id: string): void { return this.composer.removeContextSource(id); }

  private retryContextSource(id: string): void { return this.composer.retryContextSource(id); }

  private openContextPicker(): void { return this.composer.openContextPicker(); }

  private renderControls(): void { return this.composer.renderControls(); }

  private renderEmptyState(): void { return this.transcript.renderEmptyState(); }

  /** Every CLI backend the router actually exposes, paired with its module (label, sign-in hint) — skips a partial test stub instead of crashing on it. */
  private cliEntries(router: ProviderRouter): { backend: CliBackend; provider: CliSignInProvider }[] {
    const candidates: [CliBackend, CliSignInProvider | undefined][] = [
      [claudeBackend, router.claudeCli],
      [codexBackend, (router as { codexCli?: CliSignInProvider }).codexCli],
      [opencodeBackend, (router as { opencodeCli?: CliSignInProvider }).opencodeCli],
    ];
    return candidates.filter((e): e is [CliBackend, CliSignInProvider] => e[1] != null).map(([backend, provider]) => ({ backend, provider }));
  }

  /** True when chatting requires configuration the user hasn't done yet. */
  private setupRequired(): boolean {
    const router = this.plugin.router();
    const entries = this.cliEntries(router);
    const signedIn = (id: string) => entries.find((e) => e.backend.id === id)?.provider.hasCredentials() ?? false;
    return needsCredentialSetup({
      backend: router.chatBackend,
      hasAnthropicCredential: router.anthropic.hasCredentials(),
      hasClaudeCli: signedIn("claude-cli"),
      hasCodexCli: signedIn("codex-cli"),
      hasOpencodeCli: signedIn("opencode-cli"),
    });
  }


  /** Attach canonical workspace context and hand control back to the user. */
  prepareWorkspaceQuestion(workspace: Pick<CompanionWorkspaceCard, "kind" | "title" | "contextPath">): void {
    const active = this.resolveMarkdownContextView()?.file ?? this.app.workspace.getActiveFile();
    const alreadyIncludedAsActiveNote = this.plugin.settings.context.activeNote && active?.path === workspace.contextPath;
    if (!alreadyIncludedAsActiveNote && !this.attachedPaths.some(({ path, kind }) => path === workspace.contextPath && kind === "note")) {
      this.attachedPaths.push({ path: workspace.contextPath, kind: "note" });
    }
    this.inputEl.value = workspace.kind === "research"
      ? `Help me continue ${workspace.title.replace(/^Continue /, "")}. `
      : `Help me continue working with ${workspace.title.replace(/^Continue with /, "")}. `;
    this.renderContextManager();
    this.composer.autosizeInput();
    this.updateUsageBar();
    this.inputEl.focus();
  }

  clearChat(): void {
    this.detachTurnRendering();
    this.messages = [];
    this.session = { ...EMPTY_SESSION };
    // Plan Mode is per-conversation — a fresh chat starts with it off.
    this.planMode = false;
    this.updateModeControl();
    // The previous conversation is already auto-saved; detach so the next turn
    // begins a fresh one instead of continuing it.
    this.conversationId = null;
    this.pendingProjectId = null;
    this.setLocalProject(null);
    this.attachedPaths = [];
    this.attachedPages = [];
    this.composer.dismissedPageUrl = null;
    this.composer.pageOfferEl?.setCssStyles({ display: "none" });
    this.renderContextManager();
    this.messagesEl.empty();
    this.renderEmptyState();
    this.setSending(false);
    this.updateUsageBar();
  }

  private openSettings(): void {
    const app = this.app as ObsidianAppWithSettings;
    if (app.setting?.open) {
      app.setting.open();
      app.setting.openTabById?.("claude-companion");
      return;
    }
    // Some mobile shells do not expose the desktop `app.setting` controller.
    // The built-in command still opens Settings instead of making the tap a no-op.
    app.commands?.executeCommandById?.("app:open-settings");
  }

  // ---------- send / stream ----------

  private async onSend(): Promise<void> {
    if (this.streaming) {
      await this.stopCurrentTurn();
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    // Check credentials BEFORE clearing the composer — a new user's first
    // message must never be silently discarded.
    if (this.setupRequired()) {
      this.transcript.showSetupCard();
      return;
    }
    // A typed obsidian-agent skill invocation ("/wikilink-weaver <note path>") composes into a full turn with vault search on.
    const skill = parseSkillInvocation(text, SKILLS);
    if (skill) {
      const prompt = composeSkillPrompt(skill.entry, skill.args);
      const display = skillDisplay(skill.entry, skill.args);
      this.lastUserText = prompt;
      this.lastDisplay = display;
      this.inputEl.value = "";
      this.composer.autosizeInput();
      await this.run(prompt, display, undefined, { context: { searchVault: true } });
      return;
    }
    this.lastUserText = text;
    this.lastDisplay = undefined;
    this.inputEl.value = "";
    this.composer.autosizeInput();
    await this.run(text);
  }

  private syncSlashMenu(): void { return this.composer.syncSlashMenu(); }

  /** Re-read the templates folder and rebuild the slash catalog (templates last). */
  private async reloadTemplates(): Promise<void> {
    const generation = ++this.templateReloadGeneration;
    const templates = await this.plugin.promptTemplates();
    if (generation !== this.templateReloadGeneration) return;
    this.templateCommands = templates.map(templateSlashCommand);
    this.slashMenu.setCommands([...SLASH_COMMANDS, ...workflowSlashCommands(WORKFLOWS), ...skillSlashCommands(SKILLS, WORKFLOWS), ...this.templateCommands]);
    this.syncSlashMenu();
  }

  /** Execute a chosen slash command — either send a prompt or run an action. */
  private async runSlashCommand(cmd: SlashCommand): Promise<void> {
    if (await runNativeSlashCommand({
      command: cmd,
      backend: this.plugin.settings.chatBackend,
      clearComposer: () => {
        this.inputEl.value = "";
        this.composer.autosizeInput();
      },
      activateResearchDesk: () => this.plugin.activateResearchDesk(),
      requestCompletion: (prompt, display) => this.submitPrompt(prompt, display),
    })) return;

    this.inputEl.value = "";
    this.composer.autosizeInput();

    // User template: substitute placeholders against the live editor state,
    // then send with the note's optional model/context overrides for this turn.
    if (cmd.template) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selection = view?.editor.getSelection() ?? "";
      const activeNote = view?.file ? await this.app.vault.cachedRead(view.file) : "";
      const prompt = substitutePlaceholders(cmd.template.prompt, { selection, activeNote });
      await this.submitPrompt(prompt, `/${cmd.name}`, undefined, {
        ...(cmd.template.model ? { model: cmd.template.model } : {}),
        ...(cmd.template.context ? { context: cmd.template.context } : {}),
      });
      return;
    }

    if (cmd.kind === "prompt" && cmd.prompt) {
      if (cmd.awaitsInput) {
        // Insert the template and let the user finish typing (e.g. "/explain ").
        this.inputEl.value = cmd.prompt;
        this.inputEl.focus();
        this.composer.autosizeInput();
        this.updateUsageBar();
        return;
      }
      // Hide the verbose template behind the command name; the model still gets cmd.prompt.
      await this.submitPrompt(cmd.prompt, `/${cmd.name}`);
      return;
    }

    // A skill takes arguments: insert its token and let the user finish typing; Enter sends through onSend.
    if (cmd.action?.startsWith(SKILL_ACTION_PREFIX)) {
      this.inputEl.value = `/${cmd.action.slice(SKILL_ACTION_PREFIX.length)} `;
      this.inputEl.focus();
      this.composer.autosizeInput();
      this.updateUsageBar();
      return;
    }

    // A workflow slash command ("/manifest-pm", "/frontmatter-audit", …) runs the
    // matching catalog workflow directly.
    if (cmd.action?.startsWith(WORKFLOW_ACTION_PREFIX)) {
      const id = cmd.action.slice(WORKFLOW_ACTION_PREFIX.length);
      const wf = WORKFLOWS.find((w) => w.id === id);
      if (wf) await this.plugin.runWorkflow(wf);
      else new Notice(`Unknown workflow: ${id}`);
      return;
    }

    // kind: "action" — dispatch to the matching behavior.
    switch (cmd.action) {
      case "new-chat":
        this.clearChat();
        break;
      case "workflows":
        await this.plugin.openWorkflowPicker();
        break;
      case "frontmatter":
        await this.plugin.suggestFrontmatterForActiveNote();
        break;
      case "capture-memory":
        await this.plugin.openSessionPicker();
        break;
      case "history":
        this.openHistory();
        break;
      case "save":
        await this.transcript.saveChat();
        break;
      case "delete-active":
        await this.plugin.deleteActiveConversation();
        break;
      case "ask-vault":
        this.plugin.settings.context.searchVault = true;
        await this.plugin.saveSettings();
        this.inputEl.value = "";
        this.inputEl.setAttr("placeholder", "Vault search on — ask your question…");
        this.inputEl.focus();
        quickNotice("Vault search enabled for your next message.");
        break;
      case "artifact":
        await this.plugin.generateArtifactFromContext();
        break;
      case "plan":
        await this.plugin.generatePlanFromNote();
        break;
      case "build":
        await this.plugin.handoffToBuild();
        break;
      default:
        new Notice(`Unknown command: /${cmd.name}`);
    }
  }

  private setSending(sending: boolean): void {
    this.streaming = sending;
    this.sendBtn.toggleClass("is-stop", sending);
    this.sendBtn.setAttr("aria-label", sending ? "Stop generating" : "Send message");
    if (Platform.isMobile) {
      this.sendBtn.empty();
      setIcon(this.sendBtn, sending ? "square" : "arrow-up");
    } else {
      this.sendBtn.setText(sending ? "Stop" : "Send");
    }
  }

  private async run(userText: string, display?: string, maxTokens?: number, opts?: { model?: string; context?: Partial<ContextToggles> }): Promise<void> {
    this.maxTokensOverride = maxTokens ?? null; // reset each turn
    this.turnModelOverride = opts?.model ?? null;
    this.turnContextOverride = opts?.context ?? null;
    this._lastBuffer = ""; // never let a previous turn's partial leak into this one
    void this.refreshBackendPill();
    const router = this.plugin.router();
    let { provider, model } = router.chatProvider();
    const backend = router.chatBackend;
    let caps = router.chatCapabilities();
    if ((backend === "claude-cli" || backend === "codex-cli" || backend === "opencode-cli") && !caps.cli && !router.anthropic.hasCredentials()) {
      const entry = this.cliEntries(router).find((e) => e.backend.id === backend);
      const label = entry?.backend.label ?? "This backend";
      // The cached sign-in probe can be stale (user just ran the sign-in command); re-probe once before blocking.
      if (entry?.provider.available()) {
        await entry.provider.refresh();
        caps = router.chatCapabilities();
        if (caps.cli) {
          ({ provider, model } = router.chatProvider());
          void this.refreshBackendPill();
        }
      }
      if (!caps.cli) {
        new Notice(entry?.provider.available() ? `${label} is not signed in — ${entry.backend.signInHint}, or add an API key in Companion settings.` : `${label} runs on desktop only. Add an API key to chat here.`);
        return;
      }
    }
    if (!provider.hasCredentials() && backend !== "auto") {
      const where =
        provider.id === "ollama"
          ? "Start Ollama (`ollama serve`) or set the host in settings."
          : provider.id === "openai-compat"
            ? "Set the endpoint host and model in Companion settings → Local models."
            : "Add your Anthropic credential in Claude Companion settings first.";
      new Notice(where);
      return;
    }

    this.messages.push({ role: "user", content: userText, ...(display !== undefined ? { display } : {}) });
    // Snapshot now (not read from `this.messages` at completion) — the view may
    // switch conversations while this turn is still in flight.
    const turnMessages = [...this.messages];
    let turn: { conversationId: string; turnId: string };
    try {
      turn = await this.plugin.beginActiveConversationTurn(this.conversationId, this.messages, {
        backend,
        model: this.turnModelOverride ?? model,
        mode: this.currentMode(),
      });
    } catch (error) {
      this.messages.pop();
      if (this.inputEl) {
        this.inputEl.value = userText;
        this.composer.autosizeInput();
      }
      new Notice(`Couldn't save this request, so it was not started: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.conversationId = turn.conversationId;
    this.refreshTabTitle();
    if (this.pendingProjectId !== null) { await this.plugin.setChatProject(turn.conversationId, this.pendingProjectId); this.pendingProjectId = null; }
    await this.refreshCurrentProject(); // memoized for the rest of this turn
    this.currentTurn = turn;
    this.abort = new AbortController();
    const controller = this.abort;
    this.unregisterCurrentTurn = this.plugin.registerActiveChatTurn(turn.conversationId, turn.turnId, () => {
      controller.abort();
      if (this.currentTurn?.turnId === turn.turnId) {
        this.currentTurn = null;
        this.unregisterCurrentTurn = null;
        this.setSending(false);
      }
    });
    this.setSending(true);
    this._turnUsage = null;
    this.transcript.renderMessage("user", display ?? userText, { command: display !== undefined });

    // Agent mode: the model pulls vault context itself via tools. Gated on the
    // provider actually round-tripping tool_use (Claude, and local models whose
    // metadata reports "tools") — local-only setups get the same agent.
    const toolCapable = await router.chatToolCapable();
    if (controller.signal.aborted) return;
    this.agentCapable = this.plugin.settings.agentModeEnabled && toolCapable;
    this.updateModeControl();
    const agentActive = this.agentCapable;
    if (this.plugin.settings.agentModeEnabled && !toolCapable && caps.local) {
      new Notice(`The selected local model doesn't support tools, so the agent is off. Pick a tool-capable model (e.g. llama3.1, qwen3) in settings → Local models.`, 8000);
    }

    // Build context-augmented copy of the message list for the API. In agent
    // mode the pre-emptive vault-search stuffing is skipped — the vault_search
    // tool replaces it with better, model-chosen queries.
    const toggles = agentActive
      ? { ...this.plugin.settings.context, ...this.turnContextOverride, searchVault: false }
      : { ...this.plugin.settings.context, ...this.turnContextOverride };
    // A chat project's pinned notes join the attach list for this turn only —
    // the composer's own attachedPaths (session-scoped) stay untouched.
    const pinnedPaths: AttachedPath[] = (this.currentChatProject?.pinned ?? [])
      .filter((path) => !this.attachedPaths.some((a) => a.path === path))
      .map((path) => ({ path, kind: "note" as const }));
    const searchScope = this.currentChatProject ? projectSearchScope(this.currentChatProject) : undefined;
    const ctx = await gatherContext(
      this.app,
      this.plugin.settings,
      toggles,
      userText,
      (q, k) => this.plugin.semanticSearch(q, k, searchScope),
      [...this.attachedPaths, ...pinnedPaths],
      this.attachedPages,
      searchScope,
    );
    if (controller.signal.aborted) return;
    // A resumed Claude Code session already owns its history. Sending the whole
    // conversation again can repeat the interrupted request and duplicate writes.
    const wireMessages = this.resumeCliSessionId ? this.messages.slice(-1) : compactArtifactsInHistory(this.messages);
    const apiMessages: ApiMessage[] = toApiMessages(wireMessages);
    if (ctx.text) {
      const last = apiMessages[apiMessages.length - 1];
      if (last && typeof last.content === "string") last.content = `${ctx.text}\n\n---\n\n${last.content}`;
      this.transcript.annotateContext(ctx.sources);
    }

    // Attached PDFs/images become content blocks ahead of the text (media is
    // per-turn: consumed by this send, pills cleared). Local backends can't
    // see them — textContent() drops non-text blocks on the Ollama path.
    if (this.attachedMedia.length > 0) {
      const blocks = await this.composer.mediaBlocks();
      if (controller.signal.aborted) return;
      const last = apiMessages[apiMessages.length - 1];
      if (blocks.length > 0 && last && typeof last.content === "string") {
        last.content = [...blocks, { type: "text", text: last.content }];
      }
      // Media is per-turn, but keep a handle for failure-restore and Regenerate.
      this.lastUserMedia = this.attachedMedia;
      this.attachedMedia = [];
      this.renderContextManager();
    } else {
      this.lastUserMedia = [];
    }

    const { bubble, body } = this.transcript.createAssistantBubble();
    const startedOnLocal = caps.local;
    const wantThinking = agentActive || caps.cli
      ? !!(this.controls.thinking && this.controls.showThinking)
      : !startedOnLocal && !!(this.controls.thinking && this.controls.showThinking);
    // The primary-backend/local-fallback decision runs inside
    // ChatTurnService.start() so it keeps going — and still persists — even if
    // this view closes mid-turn. Mirrors the fallback policy run() used to
    // apply itself: an agent turn that already produced text/trace despite an
    // error is a completed answer with a notice, never a fallback trigger.
    const fallbackProviderId: ErrorHintProvider = caps.cli ? (caps.cliBackend ?? "claude-cli") : startedOnLocal ? "ollama" : "anthropic";
    const coreRun = async (handlers: AgentTurnHandlers, signal: AbortSignal): Promise<AgentTurnResult> => {
      const primary = agentActive || caps.cli
        ? await this.agentTurn(apiMessages, handlers, signal)
        : startedOnLocal
          ? await this.streamTurn("local", apiMessages, handlers, signal)
          : await this.streamTurn("claude", apiMessages, handlers, signal);
      if (!primary.error) return primary;

      const isAgent = agentActive || caps.cli;
      if (isAgent && (primary.text.trim().length > 0 || primary.trace.length > 0)) {
        handlers.onNotice?.(`Turn ended early: ${primary.error.message}`);
        return { text: primary.text, trace: primary.trace, ...(primary.aborted !== undefined ? { aborted: primary.aborted } : {}), ...(primary.capped !== undefined ? { capped: primary.capped } : {}) };
      }

      const fb = await router.localFallback();
      const doFallback = shouldFallbackToLocal({ backend, localAvailable: fb !== null, error: primary.error });
      if (!doFallback || !fb) {
        tagProvider(primary.error, fallbackProviderId);
        return primary;
      }
      handlers.onNotice?.(`${fallbackReason(primary.error)} — answered locally with ${fb.model}.`);
      const fallback = await this.streamTurn("local", apiMessages, handlers, signal, fb);
      if (fallback.error) tagProvider(fallback.error, fb.provider.id);
      return fallback;
    };

    // Cache one instance for this turn's whole lifecycle — start() and the
    // subscribe() below must land on the same ChatTurnService (plugin.turnService()
    // is a memoized singleton in production, but nothing here should rely on that).
    const turnService = this.plugin.turnService();
    const handle = turnService.start(turn.conversationId, {
      turnId: turn.turnId,
      title: display ?? userText,
      run: coreRun,
      completeTurn: (result) => this.plugin.completeActiveConversationTurn(turn.conversationId, turn.turnId, appendAssistantMessage(turnMessages, result)),
      interruptTurn: (result, error) => this.plugin.interruptActiveConversationTurn(turn.conversationId, turn.turnId, appendAssistantMessage(turnMessages, result), error?.message ?? "Interrupted"),
      registerTurn: (stop) => this.plugin.registerActiveChatTurn(turn.conversationId, turn.turnId, stop),
    });
    this.turnRenderUnsubscribe = this.transcript.startTurnRendering(turn.conversationId, bubble, body, wantThinking, turnService);
    await handle.result.catch(() => undefined);
  }

  /**
   * Run one streaming attempt on a backend, emitting through `handlers` instead
   * of touching the DOM directly — the view (attached or not) renders from the
   * ChatTurnService event stream. Always resolves; never rejects.
   */
  private streamTurn(
    target: "claude" | "local",
    apiMessages: ApiMessage[],
    handlers: AgentTurnHandlers,
    signal: AbortSignal,
    localOverride?: { provider: Provider; model: string },
  ): Promise<AgentTurnResult> {
    const router = this.plugin.router();
    const onClaude = target === "claude";
    // "local" = the configured non-Claude chat backend (Ollama, or the custom
    // OpenAI-compatible endpoint when that's the chat backend) — or, for a
    // fallback attempt, whichever local backend the router found reachable.
    const useCustom = !onClaude && !localOverride && this.plugin.settings.chatBackend === "custom";
    const provider = onClaude ? router.anthropic : localOverride?.provider ?? (useCustom ? router.openaiCompat : router.ollama);
    const model = onClaude
      ? (this.turnModelOverride ?? this.controls.model)
      : localOverride?.model ?? (useCustom ? this.plugin.settings.openaiCompatModel : this.plugin.settings.ollamaModel);
    const shape = shapeRequest({ ...this.controls, model: onClaude ? model : this.controls.model }, this.maxTokensOverride ?? this.plugin.settings.maxTokens);

    return new Promise((resolve) => {
      let settled = false;
      let buffer = "";
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        const status = (error as { status?: number } | null)?.status;
        const err = error instanceof Error ? error : new Error(String(error));
        if (status !== undefined) (err as Error & { status?: number }).status = status;
        resolve({ text: buffer, trace: [], error: err });
      };
      const request: CompletionRequest = {
        system: this.plugin.composeSystemPrompt({ project: this.currentChatProject }),
        messages: apiMessages,
        model,
        maxTokens: shape.maxTokens,
        signal,
      };
      if (onClaude && shape.temperature !== undefined) request.temperature = shape.temperature;
      if (onClaude && shape.thinking !== undefined) request.thinking = shape.thinking;
      if (onClaude && shape.thinkingDisplay !== undefined) request.thinkingDisplay = shape.thinkingDisplay;
      if (onClaude && shape.outputConfig !== undefined) request.outputConfig = shape.outputConfig;
      void provider.stream(
        request,
        {
          onThinking: (delta) => handlers.onThinking?.(delta),
          onText: (delta) => {
            buffer += delta;
            handlers.onText(delta);
          },
          onError: (err) => fail(err),
          onUsage: (usage) => handlers.onUsage?.(usage),
          onTruncated: () => handlers.onTruncated?.(),
          onDone: (full) => {
            if (settled) return;
            settled = true;
            resolve({ text: full, trace: [] });
          },
        },
      ).then(() => {
        // stream() resolved without onError/onDone (e.g. aborted) — keep the
        // partial buffer, no error.
        if (!settled) {
          settled = true;
          resolve({ text: buffer, trace: [], aborted: true });
        }
      }).catch((error: unknown) => fail(error));
    });
  }

  /**
   * Run one agent-mode turn: Claude may call vault tools between streaming
   * passes (spec 2026-07-05). Always resolves; the caller (coreRun in run())
   * decides whether an error means fallback, a completed-with-notice answer,
   * or a hard failure.
   */
  private async agentTurn(
    apiMessages: ApiMessage[],
    handlers: AgentTurnHandlers,
    signal: AbortSignal,
  ): Promise<AgentTurnResult> {
    const { provider, model: providerModel } = this.plugin.router().chatProvider();
    const shape = shapeRequest(this.controls, this.maxTokensOverride ?? this.plugin.settings.maxTokens);
    const externalTools = this.planMode ? [] : await this.plugin.externalMcpTools().catch(() => []);

    const request: CompletionRequest = {
      system: this.plugin.composeSystemPrompt({ agent: true, plan: this.planMode, project: this.currentChatProject }),
      messages: apiMessages,
      model: this.turnModelOverride ?? providerModel,
      maxTokens: shape.maxTokens,
      signal,
      // Plan Mode forces the read-only set regardless of agentAllowWrites, and
      // drops propose_note_edit — the turn should end in a plan, not an edit.
      // Otherwise propose_note_edit rides along regardless of agentAllowWrites —
      // the diff modal is its own gate (spec 2026-07-05 apply-to-note, §7 Q1).
      tools: this.planMode
        ? readOnlyAnthropicTools(this.plugin.agentTools().definitions())
        : [...toAnthropicTools(this.plugin.agentTools().definitions()), PROPOSE_EDIT_TOOL, ...externalTools],
    };
    if (shape.temperature !== undefined) request.temperature = shape.temperature;
    if (shape.thinking !== undefined) request.thinking = shape.thinking;
    if (shape.thinkingDisplay !== undefined) request.thinkingDisplay = shape.thinkingDisplay;
    if (shape.outputConfig !== undefined) request.outputConfig = shape.outputConfig;

    const deps: AgentTurnDeps = {
      stream: (req, h) => provider.stream(req, h),
      execute: (block, sig) =>
        parseExternalToolName(block.name)
          ? this.executeExternalMcp(block, sig)
          : executeTool(
              {
                call: (name, args) => this.plugin.agentTools().call(name, args),
                confirmWrite: (b) => this.confirmAgentWrite(b),
                proposeEdit: (b) => this.proposeAgentEdit(b),
              },
              block,
            ),
      maxIterations: this.plugin.settings.agentMaxIterations,
      signal,
    };

    let runner: AgentTurnRunner;
    try {
      runner = await this.turnRunnerFor(deps, request, signal);
    } catch (error) {
      return { text: "", trace: [], error: error instanceof Error ? error : new Error(String(error)) };
    }
    return runner.run(request, handlers);
  }

  /** The CLI runs the turn when the backend is Claude Code; otherwise today's provider loop does. */
  private async turnRunnerFor(deps: AgentTurnDeps, request: CompletionRequest, signal?: AbortSignal): Promise<AgentTurnRunner> {
    const caps = this.plugin.router().chatCapabilities();
    if (!caps.cli) return providerTurnRunner(deps);
    if (!this.agentCapable) request.tools = [];
    const conversationId = this.currentTurn?.conversationId ?? this.plugin.activeConversationId();
    signal?.addEventListener("abort", () => this.plugin.interruptCliTurn(conversationId), { once: true });
    return this.plugin.cliTurnRunner({
      conversationId,
      planMode: this.planMode,
      agentMode: this.agentCapable,
      model: request.model,
      deps: { confirmWrite: (b) => this.confirmAgentWrite(b), proposeEdit: (b) => this.proposeAgentEdit(b) },
      transcript: this.resumeCliSessionId ? "" : transcriptText(this.messages.slice(0, -1)),
      ...(this.resumeCliSessionId ? { resumeSessionId: this.resumeCliSessionId } : {}),
    });
  }

  /**
   * Handle a propose_note_edit call: plan against the current note, let the
   * user review per hunk inline or in the DiffModal, apply the accepted subset
   * atomically, and report the true outcome back to the model. Throws are
   * mapped to is_error tool_results by the executor (model self-corrects).
   */
  private async proposeAgentEdit(block: ToolUseBlock): Promise<string> {
    const input = block.input;
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) throw new Error("propose_note_edit requires a 'path'.");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
    const edits = parseProposedEdits(input.edits);
    const description = typeof input.description === "string" ? input.description : undefined;

    const content = await this.app.vault.cachedRead(file);
    const plan = planEdits(content, edits);

    const outcome = await reviewEdits(
      this.app,
      { file, plan, ...(description !== undefined ? { description } : {}) },
      { inlineEnabled: this.plugin.settings.inlineDiffEnabled },
    );
    const accepted = outcome.accepted;
    if (!accepted) return "User rejected the proposed edit.";

    // Inline review already edited the live buffer; the modal path applies under the write lock.
    if (outcome.mode === "modal") {
      await this.app.vault.process(file, (current) => applyPlan(current, plan, accepted));
    }
    const applied = accepted.filter(Boolean).length;
    return applied === plan.hunks.length
      ? `Applied all ${applied} edit${applied === 1 ? "" : "s"} to ${path}.`
      : `Applied ${applied} of ${plan.hunks.length} edits to ${path} (the user rejected the rest).`;
  }

  /**
   * Route an external MCP tool call: every call confirms first (external
   * servers can do anything), then dispatch; errors become is_error results
   * so the model adapts instead of the turn dying.
   */
  private async executeExternalMcp(block: ToolUseBlock, signal?: AbortSignal): Promise<ToolResultBlock> {
    const result = (content: string, isError?: boolean): ToolResultBlock => ({
      type: "tool_result",
      tool_use_id: block.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    if (block.parseError) return result(block.parseError, true);
    // Stop was pressed while a prior tool was running — don't fire another call.
    if (signal?.aborted) return result("Turn stopped before this tool ran.", true);
    if (!(await this.confirmAgentWrite(block))) return result("User declined.", true);
    try {
      return result(truncateResult(await this.plugin.callExternalMcp(block.name, block.input)));
    } catch (err) {
      return result(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** Ask the user before an agent write tool runs; honors "allow for this session". */
  private confirmAgentWrite(block: ToolUseBlock): Promise<boolean> {
    if (this.agentWriteAlways) return Promise.resolve(true);
    return new Promise((resolve) => {
      new WriteConfirmModal(this.app, block, (choice) => {
        if (choice === "always") {
          this.agentWriteAlways = true;
          this.header.updateWriteGrantPill();
        }
        resolve(choice !== "deny");
      }).open();
    });
  }

  /** Push the chatFontSize setting onto the view as --cc-chat-font (drives .cc-body). */
  private applyChatFontSize(): void {
    this.containerEl.style.setProperty("--cc-chat-font", `${this.plugin.settings.chatFontSize}px`);
  }

  /** Displayed mode: Plan wins over Act, otherwise Act iff writes are allowed. */
  private currentMode(): ChatMode {
    return this.planMode ? "plan" : this.plugin.settings.agentAllowWrites ? "act" : "ask";
  }

  /** Reflect the mode control: hidden when the session can't act, state from currentMode(). */
  private updateModeControl(): void {
    this.composer.modeControl?.setVisible(this.agentCapable);
    this.composer.modeControl?.set(this.currentMode());
  }

  /** Apply an Ask / Plan / Act switch: writes setting + Plan Mode, the matching notice, then persist if writes changed. */
  private async applyMode(mode: ChatMode): Promise<void> {
    // Plan leaves the writes setting untouched — only Ask/Act set it.
    const previousWrites = this.plugin.settings.agentAllowWrites;
    const previousPlanMode = this.planMode;
    let writesChanged = false;
    if (mode !== "plan") {
      const writesOn = mode === "act";
      writesChanged = this.plugin.settings.agentAllowWrites !== writesOn;
      this.plugin.settings.agentAllowWrites = writesOn;
    }
    this.planMode = mode === "plan";
    this.updateModeControl();
    quickNotice(
      mode === "act"
        ? "Act on vault: on — I'll create and edit notes (each change asks first)."
        : mode === "plan"
          ? "Plan Mode: on — I'll explore read-only and propose a plan, no writes."
          : "Act on vault: off — chat only, I won't change your vault.",
    );
    if (writesChanged) {
      try {
        await this.plugin.saveSettings();
      } catch (e) {
        this.plugin.settings.agentAllowWrites = previousWrites;
        this.planMode = previousPlanMode;
        this.updateModeControl();
        quickNotice(`Couldn't save the mode: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async stopCurrentTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) {
      this.abort?.abort();
      return;
    }
    await this.plugin.stopActiveChatTurn(turn.conversationId, turn.turnId);
  }

  async resumeInterruptedTurn(conversation: Conversation): Promise<void> {
    const receipt = conversation.activeTurn;
    if (!receipt || (receipt.state !== "interrupted" && receipt.state !== "failed")) return;
    this.resumeCliSessionId = receipt.cliSessionId ?? conversation.cliSessionId ?? null;
    try {
      await this.run(
        "Inspect the current vault state, report what the interrupted task already completed, and continue only unfinished work. Do not repeat completed writes.",
        "Resume interrupted task",
      );
    } finally {
      this.resumeCliSessionId = null;
    }
  }

  // ---------- rendering ----------

  /** Re-attach the failed turn's media so a retry (or edit) still has it. */
  private restoreMediaAfterFailure(): void {
    if (this.lastUserMedia.length > 0 && this.attachedMedia.length === 0) {
      this.attachedMedia = this.lastUserMedia;
      this.renderContextManager();
    }
  }

  refreshBackendPill(): Promise<void> { return this.header.refreshBackendPill(); }

  refreshContextStatus(): Promise<void> { return this.header.refreshContextStatus(); }

  private resolveMarkdownContextView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      this.lastMarkdownView = active;
      this.lastMarkdownFilePath = active.file.path;
      return active;
    }

    const activeFile = this.app.workspace.getActiveFile();
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    const views = leaves.map((leaf) => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && !!view.file);
    const byActiveFile = activeFile ? views.find((view) => view.file?.path === activeFile.path) : null;
    const byLastFile = this.lastMarkdownFilePath ? views.find((view) => view.file?.path === this.lastMarkdownFilePath) : null;
    const fallback = byActiveFile ?? byLastFile ?? this.lastMarkdownView;
    if (fallback?.file) {
      this.lastMarkdownView = fallback;
      this.lastMarkdownFilePath = fallback.file.path;
      return fallback;
    }
    return null;
  }

  private openMcpMenu(anchor: MouseEvent | HTMLElement): void { return this.header.openMcpMenu(anchor); }

  private openOverflowMenu(): void { return this.header.openOverflowMenu(); }

  private openModelMenu(): void { return this.header.openModelMenu(); }

  private async renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void> {
    const version = this.bumpRenderVersion(el);
    const rendered = createDiv();
    await MarkdownRenderer.render(this.app, markdown, rendered, this.app.workspace.getActiveFile()?.path ?? "", this);
    if (this.renderVersions.get(el) !== version) return;
    el.replaceChildren(...Array.from(rendered.childNodes));
  }

  /**
   * While a `claude-html` artifact is streaming, don't dump its raw HTML source
   * into the bubble. Render whatever prose preceded the fence as markdown and put
   * a compact "building" chip in the artifact's place; the final `renderMarkdownInto`
   * on `onDone` swaps in the sandboxed iframe. Painted once per artifact (flush
   * guards re-entry) so the chip and lead-in prose stay stable, not re-rendered
   * every frame.
   */
  private renderStreamingArtifactInto(el: HTMLElement, buffer: string): void {
    const { before } = splitStreamingArtifact(buffer);
    const version = this.bumpRenderVersion(el);
    const rendered = createDiv();
    const paint = (): void => {
      if (this.renderVersions.get(el) !== version) return;
      const chip = rendered.createDiv({ cls: "cc-artifact-building" });
      chip.createSpan({ cls: "cc-artifact-building-label", text: "Building artifact…" });
      el.replaceChildren(...Array.from(rendered.childNodes));
    };
    if (before.trim().length > 0) {
      void MarkdownRenderer.render(this.app, before, rendered, this.app.workspace.getActiveFile()?.path ?? "", this).then(paint);
    } else {
      paint();
    }
  }

  private bumpRenderVersion(el: HTMLElement): number {
    const version = (this.renderVersions.get(el) ?? 0) + 1;
    this.renderVersions.set(el, version);
    return version;
  }

  /** Drop the last assistant reply and re-run the previous user turn. */
  private async regenerate(opts?: { maxTokens?: number }): Promise<void> {
    if (this.streaming || !this.lastUserText) return;
    // Remove the trailing assistant message from state + DOM, plus the user msg
    // (run() re-pushes it). Then re-run with the same text.
    if (this.messages[this.messages.length - 1]?.role === "assistant") this.messages.pop();
    if (this.messages[this.messages.length - 1]?.role === "user") this.messages.pop();
    // Rebuild the transcript cleanly so we don't leave a stale bubble.
    this.messagesEl.empty();
    if (this.messages.length === 0) this.renderEmptyState();
    else for (const m of this.messages) this.renderStoredMessage(m);
    // Re-attach the original turn's media so the regenerated turn sees it too.
    if (this.attachedMedia.length === 0 && this.lastUserMedia.length > 0) {
      this.attachedMedia = [...this.lastUserMedia];
    }
    await this.run(this.lastUserText, this.lastDisplay, opts?.maxTokens);
  }

}
