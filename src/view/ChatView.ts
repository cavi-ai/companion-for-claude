import { ItemView, MarkdownView, Notice, Platform, WorkspaceLeaf, setIcon, type ViewStateResult } from "obsidian";
import type { ChatViewHost } from "./chat/hosts";
import type { ChatMessage, ContextToggles } from "../types";
import { effectiveToggles } from "./chat/contextScope";
import type { AgentTurnHandlers, AgentTurnResult } from "../agent/loop";
import { continuationFor, shouldAutoContinue } from "./chat/continuation";
import { preflightTurn, startTurn, turnPersistence } from "../chat/turnStart";
import type { ApiMessage } from "../providers/types";
import { compactArtifactsInHistory, compactMessages, toApiMessages, type Conversation } from "../conversations/store";
import { resolveModelId } from "../claude/models";
import { type ChatControls, defaultChatControls } from "../claude/chatControls";
import { routeTurn } from "../providers/chatTurn";
import { SlashMenu } from "./SlashMenu";
import type { ChatModeState } from "./chat/chatMode";
import { ChatSession, type TurnState } from "./chat/chatSession";
import { type AttachedPage } from "../context/urlContext";
import { SKILLS } from "../workflows/skillRegistry.generated";
import { composeSkillPrompt, parseSkillInvocation, skillDisplay } from "../skills/compose";
import { gatherContext, type AttachedPath } from "../context/vaultContext";
import { type MediaAttachment } from "../context/attachments";
import { type AtItem } from "../context/atMention";
import { projectSearchScope, type ChatProject } from "../projects/model";
import { credentialSetupInputs, needsCredentialSetup } from "../providers/setupState";
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
import { pinChatAboveKeyboard } from "./chat/keyboardPin";
import { Transcript } from "./chat/Transcript";
import { TurnRunners } from "./chat/turnRunners";
import { ChatProjectBinding } from "./chat/projectBinding";
import { SetupCard } from "./chat/SetupCard";
import { SlashRunner } from "./chat/slashRunner";
import { VersionedMarkdownRenderer } from "./chat/markdownRender";

export const CHAT_VIEW_TYPE = "claude-companion-chat";

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
  /** The conversation state the composer, header, and transcript share. */
  readonly chat: ChatSession;
  get mode(): ChatModeState { return this.chat.mode; }
  private get messages(): ChatMessage[] { return this.chat.messages; }
  private set messages(v: ChatMessage[]) { this.chat.messages = v; }
  private transcript: Transcript;
  private runners: TurnRunners;
  private projects: ChatProjectBinding;
  private slash: SlashRunner;
  private renderer: VersionedMarkdownRenderer;
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
  private get streaming(): boolean { return this.chat.streaming; }
  private set streaming(v: boolean) { this.chat.streaming = v; }
  private get turn(): TurnState { return this.chat.turn; }
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
  private continuationDepth = 0;
  private get session(): SessionUsage { return this.turn.session; }
  private set session(v: SessionUsage) { this.turn.session = v; }
  /** Usage for the in-flight turn; folded into the session once on completion. */
  private get _turnUsage(): TokenUsage | null { return this.turn.turnUsage; }
  private set _turnUsage(v: TokenUsage | null) { this.turn.turnUsage = v; }
  /** Per-session chat controls (model, thinking, effort, temp, max). */
  private get controls(): ChatControls { return this.chat.controls; }
  private set controls(v: ChatControls) { this.chat.controls = v; }
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
  private get contextToggles(): ContextToggles { return this.composer.contextToggles; }
  private set contextToggles(v: ContextToggles) { this.composer.contextToggles = v; }
  /** Media consumed by the last send — restored on failure, re-sent on Regenerate. */
  private lastUserMedia: MediaAttachment[] = [];
  /** Per-turn max-output override (artifact/plan/workflow flows need headroom). */
  private maxTokensOverride: number | null = null;
  private contextStatusInterval: number | null = null;
  private unpinKeyboard: (() => void) | null = null;
  /** Last visible context-manager state; skip DOM rebuilds when nothing changed. */
  private get lastContextManagerSignature(): string { return this.composer.lastContextManagerSignature; }
  private set lastContextManagerSignature(v: string) { this.composer.lastContextManagerSignature = v; }
  private lastMarkdownView: MarkdownView | null = null;
  private lastMarkdownFilePath: string | null = null;
  /** The last user message text, for the Regenerate action. */
  private get lastUserText(): string { return this.chat.lastUserText; }
  private set lastUserText(v: string) { this.chat.lastUserText = v; }
  /** The last user-bubble display text, when it differs from lastUserText (skill turns). */
  private lastDisplay: string | undefined = undefined;
  private get slashMenu(): SlashMenu { return this.composer.slashMenu; }
  private set slashMenu(v: SlashMenu) { this.composer.slashMenu = v; }
  /** The chat project this.conversationId is scoped to (null = none), kept in sync with the conversation. */
  private get currentChatProject(): ChatProject | null { return this.chat.project; }
  private set currentChatProject(v: ChatProject | null) { this.chat.project = v; }
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
  /** Guards the setup card's background sign-in probe against stacking on re-render, per CLI backend id. */

  /** The conversation this leaf shows; null for an unstarted "New chat tab". Persisted via getState/setState. */
  private conversationId: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ChatViewHost,
  ) {
    super(leaf);
    this.chat = new ChatSession({
      writes: () => plugin.settings.agentAllowWrites,
      setWrites: (on) => { plugin.settings.agentAllowWrites = on; },
      save: () => plugin.saveSettings(),
      notify: (message) => quickNotice(message),
    });
    this.setupCard = new SetupCard({
      plugin,
      cliEntries: (router) => this.cliEntries(router),
      messagesEl: () => this.messagesEl,
      hasMessages: () => this.messages.length > 0,
      renderEmptyState: () => this.renderEmptyState(),
      refreshModelLabel: () => this.refreshModelLabel(),
      openSettings: () => this.openSettings(),
    });
    this.renderer = new VersionedMarkdownRenderer(this.app, this);
    this.slash = new SlashRunner(this.app, plugin, {
      clearInput: () => {
        this.inputEl.value = "";
        this.composer.autosizeInput();
      },
      setDraft: (text) => this.composer.setDraft(text),
      updateUsageBar: () => this.updateUsageBar(),
      submitPrompt: (...args) => this.submitPrompt(...args),
      setCommands: (commands) => {
        this.slashMenu.setCommands(commands);
        this.composer.syncSlashMenu();
      },
      view: {
        newChat: () => this.clearChat(),
        openHistory: () => this.openHistory(),
        save: () => this.distillThisChat(),
        askVault: () => {
          this.enableVaultSearchForChat();
          this.inputEl.value = "";
          this.inputEl.setAttr("placeholder", "Vault search on — ask your question…");
          this.inputEl.focus();
          quickNotice("Vault search on for this chat.");
        },
      },
    });
    this.transcript = new Transcript(this.app, plugin, this.chat, {
      setDraft: (text) => this.composer.setDraft(text),
      onSend: (...args) => this.onSend(...args),
      prepareWorkspaceQuestion: (...args) => this.prepareWorkspaceQuestion(...args),
      regenerate: (...args) => this.regenerate(...args),
      renderMarkdownInto: (...args) => this.renderer.renderInto(...args),
      renderSetupCard: (parent) => this.setupCard.render(parent),
      renderStreamingArtifactInto: (...args) => this.renderer.renderStreamingArtifactInto(...args),
      resumeInterruptedTurn: (...args) => this.resumeInterruptedTurn(...args),
      reviewLastProposedEdit: (...args) => this.runners.reviewLastProposedEdit(...args),
      discardLastProposedEdit: (...args) => this.runners.discardLastProposedEdit(...args),
      restoreMediaAfterFailure: (...args) => this.restoreMediaAfterFailure(...args),
      setSending: (...args) => this.setSending(...args),
      setupRequired: (...args) => this.setupRequired(...args),
      submitPrompt: async (text, display) => { await this.submitPrompt(text, display); },
      updateUsageBar: (...args) => this.updateUsageBar(...args),
    });
    this.header = new HeaderControls(this.app, plugin, this.chat, {
      anyContextEnabled: () => this.composer.anyContextEnabled(),
      clearChat: (...args) => this.clearChat(...args),
      cliEntries: (...args) => this.cliEntries(...args),
      loadConversation: (...args) => this.loadConversation(...args),
      openSettings: (...args) => this.openSettings(...args),
      renderContextManager: (...args) => this.renderContextManager(...args),
      renderKnobs: () => this.composer.renderKnobs(),
      renderKnobsInto: (parent) => this.composer.renderKnobsInto(parent),
      distillChat: () => this.distillThisChat(),
      draft: () => this.composer.draft(),
      showReasoning: (active, label) => this.composer.showReasoning(active, label),
    });
    this.projects = new ChatProjectBinding(this.app, plugin, this.chat, {
      conversationId: () => this.conversationId,
      showProject: (project) => {
        this.composer.setProjectPill(project);
        this.header.setProjectLabel(project?.name ?? null);
      },
      updateUsageBar: () => this.updateUsageBar(),
    });
    this.runners = new TurnRunners(this.app, plugin, this.chat, {
      turnOverrides: () => ({ model: this.turnModelOverride, maxTokens: this.maxTokensOverride }),
      resumeCliSessionId: () => this.resumeCliSessionId,
      conversationId: () => this.conversationId,
      onWriteGrant: () => this.header.updateWriteGrantPill(),
      renderRecoverableEdit: (conversation) => this.transcript.renderRecoverableEdit(conversation),
      removeEditRecovery: () => this.messagesEl.querySelector(".cc-edit-recovery")?.remove(),
    });
    this.composer = new Composer(this.app, plugin, this.chat, {
      applyChatFontSize: (...args) => this.applyChatFontSize(...args),
      onModelSelect: (...args) => this.header.onModelSelect(...args),
      refreshCapabilityIndicators: (...args) => this.header.refreshCapabilityIndicators(...args),
      registerDomEvent: (el, type, callback) => this.registerDomEvent(el, type, callback),
      resolveMarkdownContextView: (...args) => this.resolveMarkdownContextView(...args),
      updateUsageBar: (...args) => this.updateUsageBar(...args),
      cachedClaims: () => this.projects.claims(),
      cachedProjects: () => this.projects.projectOptions(),
      mountUsage: (parent) => this.header.mountUsage(parent),
      onSlashCommand: (cmd) => void this.slash.run(cmd),
      pickAtItems: () => (this.activeMenuTrigger === "#" ? this.hashItems() : this.atItems()),
      onAtChoose: (item) => this.onAtChoose(item),
      toggleAutomatic: (key, enabled) => this.toggleAutomaticContext(key, enabled),
      removeSource: (id) => this.removeContextSource(id),
      retrySource: (id) => this.retryContextSource(id),
      addContext: () => this.openContextPicker(),
      onSend: () => void this.onSend(),
      syncSlashMenu: () => this.composer.syncSlashMenu(),
      chooseProject: (id) => this.projects.chooseById(id),
    });
  }

  override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  override getDisplayText(): string {
    const conversation = this.conversationId ? this.plugin.conversations().list().find((c) => c.id === this.conversationId) : undefined;
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
      const conversation = this.plugin.conversations().list().find((c) => c.id === raw);
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
        this.chat.writeGrant = false;
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
      this.slash.initialCatalog(),
    );
    this.unpinKeyboard?.();
    this.unpinKeyboard = Platform.isMobile ? pinChatAboveKeyboard(root, window) : null;
    this.renderContextManager();

    // User templates: load now, refresh when a note in the folder changes.
    this.slash.watch((ref) => this.registerEvent(ref));

    this.projects.watch((ref) => this.registerEvent(ref));

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
    const active = this.plugin.conversations().getActive();
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
    this.projects.forget();
    void this.projects.refreshCurrent();
    this.session = { ...EMPTY_SESSION };
    this.messages = compactMessages(conversation.messages);
    const lastUser = [...this.messages].reverse().find((message) => message.role === "user");
    this.lastUserText = lastUser?.content ?? "";
    this.lastDisplay = lastUser?.display;
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.renderEmptyState();
    } else {
      for (const m of this.messages) this.renderStoredMessage(m);
      const live = this.plugin.turnService().live(conversation.id);
      if (live) this.attachLiveTurn(conversation.id, live.turnId);
      else if (conversation.activeTurn) this.transcript.renderInterruptedTurn(conversation);
      this.transcript.renderRecoverableEdit(conversation);
    }
    this.updateUsageBar();
    this.transcript.jumpToBottom();
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
    this.projects.forget();
    this.messages = [];
    this.session = { ...EMPTY_SESSION };
    this.messagesEl.empty();
    this.renderEmptyState();
    this.updateUsageBar();
    this.refreshTabTitle();
  }

  openHistory(): void { return this.header.openHistory(); }

  /** Distill this chat into a summary note, then file it into session memory when that is on. */
  async distillThisChat(): Promise<void> {
    if (this.conversationId === null || this.messages.length === 0) {
      new Notice("Nothing to distill yet.");
      return;
    }
    const path = await this.plugin.sessionActions().distill(this.conversationId);
    if (path !== null && this.plugin.settings.memoryEnabled && this.plugin.settings.memoryIngestOnSave) {
      await this.plugin.memory().captureConversation(this.messages);
    }
  }

  private updateUsageBar(): void { return this.header.updateUsageBar(); }

  override async onClose(): Promise<void> {
    this.slash.dispose();
    this.projects.dispose();
    this.header.teardown(false);
    // A live turn keeps running (and persisting) after the pane closes — only
    // detach this view from its event stream (ChatTurnService).
    this.detachTurnRendering();
    this.transcript.clearThinkingStatus();
    this.transcript.stopFollowing();
    if (this.contextStatusInterval !== null) {
      window.clearInterval(this.contextStatusInterval);
      this.contextStatusInterval = null;
    }
    this.unpinKeyboard?.();
    this.unpinKeyboard = null;
    this.composer.destroy();
  }

  refreshModelLabel(): void { return this.header.refreshModelLabel(); }

  // ---------- public entry point (used by commands) ----------

  async submitPrompt(text: string, display?: string, maxTokens?: number, opts?: { model?: string; context?: Partial<ContextToggles> }): Promise<boolean> {
    if (!text.trim() || this.streaming) return false;
    this.inputEl.value = "";
    return this.run(text.trim(), display, maxTokens, opts);
  }

  // ---------- "@" context picker ----------

  private atItems(): AtItem[] { return this.composer.atItems(); }

  private hashItems(): AtItem[] { return this.composer.hashItems(); }

  /** Apply a project chosen from the "@" menu or the "Chat: choose project" command. */
  applyChosenProject(project: ChatProject): Promise<void> { return this.projects.applyChosen(project); }

  private onAtChoose(item: AtItem): void { this.composer.onAtChoose(item); }

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
    return needsCredentialSetup(credentialSetupInputs(this.plugin.router()));
  }


  /** Attach canonical workspace context and hand control back to the user. */
  attachNote(path: string): void {
    const active = this.resolveMarkdownContextView()?.file ?? this.app.workspace.getActiveFile();
    const alreadyIncludedAsActiveNote = this.contextToggles.activeNote && active?.path === path;
    if (!alreadyIncludedAsActiveNote && !this.attachedPaths.some(({ path: attached, kind }) => attached === path && kind === "note")) {
      this.attachedPaths.push({ path, kind: "note" });
    }
    this.renderContextManager();
  }

  prepareWorkspaceQuestion(workspace: Pick<CompanionWorkspaceCard, "kind" | "title" | "contextPath">): void {
    this.attachNote(workspace.contextPath);
    this.composer.setDraft(workspace.kind === "research"
      ? `Help me continue ${workspace.title.replace(/^Continue /, "")}. `
      : `Help me continue working with ${workspace.title.replace(/^Continue with /, "")}. `);
    this.updateUsageBar();
  }

  enableVaultSearchForChat(): void { this.toggleAutomaticContext("searchVault", true); }

  clearChat(): void {
    this.detachTurnRendering();
    this.chat.clear();
    // The previous conversation is already auto-saved; detach so the next turn
    // begins a fresh one instead of continuing it.
    this.conversationId = null;
    this.projects.clear();
    this.attachedPaths = [];
    this.attachedPages = [];
    this.composer.resetContextToggles();
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

  private async run(userText: string, display?: string, maxTokens?: number, opts?: { model?: string; context?: Partial<ContextToggles> }): Promise<boolean> {
    this.maxTokensOverride = maxTokens ?? null; // reset each turn
    this.turnModelOverride = opts?.model ?? null;
    this.turnContextOverride = opts?.context ?? null;
    this._lastBuffer = ""; // never let a previous turn's partial leak into this one
    this.transcript.clearInterruptedTurnRow();
    void this.refreshBackendPill();
    const router = this.plugin.router();
    const backend = router.chatBackend;
    const preflight = await preflightTurn({
      backend,
      chatProvider: () => router.chatProvider(),
      chatCapabilities: () => router.chatCapabilities(),
      anthropicHasCredentials: () => router.anthropic.hasCredentials(),
      cliSignIn: () => {
        const entry = this.cliEntries(router).find((e) => e.backend.id === backend);
        return entry ? { label: entry.backend.label, signInHint: entry.backend.signInHint, available: () => entry.provider.available(), refresh: () => entry.provider.refresh() } : null;
      },
    });
    if (!preflight.ok) {
      new Notice(preflight.notice);
      return false;
    }
    const { provider, model, caps } = preflight;
    if (preflight.reprobed) void this.refreshBackendPill();

    const previousTurn = this.conversationId ? this.plugin.conversations().list().find((entry) => entry.id === this.conversationId)?.activeTurn : undefined;
    const started = await startTurn((conversationId, messages, input) => this.plugin.conversations().beginTurn(conversationId, messages, input), {
      conversationId: this.conversationId,
      messages: this.messages,
      previousTurn,
      user: { content: userText, ...(display !== undefined ? { display } : {}) },
      backend,
      model: this.turnModelOverride ?? model,
      mode: this.mode.mode,
      continuationDepth: this.continuationDepth,
    });
    if (!started.ok) {
      if (this.inputEl) {
        this.inputEl.value = userText;
        this.composer.autosizeInput();
      }
      new Notice(started.notice);
      return false;
    }
    const { turn, turnMessages } = started;
    this.messages = started.messages;
    this.conversationId = turn.conversationId;
    this.refreshTabTitle();
    await this.projects.bindPending(turn.conversationId);
    await this.projects.refreshCurrent(); // memoized for the rest of this turn
    this.currentTurn = turn;
    this.abort = new AbortController();
    const controller = this.abort;
    this.unregisterCurrentTurn = this.plugin.conversations().registerTurn(turn.conversationId, turn.turnId, () => {
      controller.abort();
      if (this.currentTurn?.turnId === turn.turnId) {
        this.currentTurn = null;
        this.unregisterCurrentTurn = null;
        this.setSending(false);
      }
    });
    this.setSending(true);
    this._turnUsage = null;
    this.transcript.renderMessage("user", display ?? userText, { command: display !== undefined, prompt: userText });

    // Agent mode: the model pulls vault context itself via tools. Gated on the
    // provider actually round-tripping tool_use (Claude, and local models whose
    // metadata reports "tools") — local-only setups get the same agent.
    const toolCapable = await router.chatToolCapable();
    if (controller.signal.aborted) return true;
    this.mode.setCapable(this.plugin.settings.agentModeEnabled && toolCapable);
    const agentActive = this.mode.capable;
    if (this.plugin.settings.agentModeEnabled && !toolCapable && caps.local) {
      new Notice(provider.id === "device" ? "On-device GPU models support text chat. Agent tools are off for this backend." : "The selected local model doesn't support tools, so the agent is off. Pick a tool-capable model (e.g. llama3.1, qwen3) in settings → Local models.", 8000);
    }

    // Build context-augmented copy of the message list for the API. In agent
    // mode the pre-emptive vault-search stuffing is skipped — the vault_search
    // tool replaces it with better, model-chosen queries.
    const toggles = effectiveToggles(this.contextToggles, this.turnContextOverride, agentActive);
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
      (q, k) => this.plugin.semantic().semanticSearch(q, k, searchScope),
      [...this.attachedPaths, ...pinnedPaths],
      this.attachedPages,
      searchScope,
      toggles.linkedNotes || toggles.searchVault ? await this.plugin.loadedOntology() : null,
    );
    if (controller.signal.aborted) return true;
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
      if (controller.signal.aborted) return true;
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
    // Routing runs inside ChatTurnService.start() so it keeps going — and still
    // persists — even if this view closes mid-turn.
    const agentRoute = agentActive || caps.cli;
    const coreRun = (handlers: AgentTurnHandlers, signal: AbortSignal): Promise<AgentTurnResult> => routeTurn(
      { backend, agent: agentRoute, providerId: provider.id },
      {
        primary: () => agentRoute
          ? this.runners.agentTurn(apiMessages, handlers, signal, turn.conversationId)
          : this.runners.streamTurn(startedOnLocal ? "local" : "claude", apiMessages, handlers, signal),
        localFallback: () => router.localFallback(),
        local: (fallback) => this.runners.streamTurn("local", apiMessages, handlers, signal, fallback),
      },
      handlers,
    );

    // Cache one instance for this turn's whole lifecycle — start() and the
    // subscribe() below must land on the same ChatTurnService (plugin.turnService()
    // is a memoized singleton in production, but nothing here should rely on that).
    const turnService = this.plugin.turnService();
    this.unregisterCurrentTurn?.();
    this.unregisterCurrentTurn = null;
    const handle = turnService.start(turn.conversationId, {
      turnId: turn.turnId,
      title: display ?? userText,
      run: coreRun,
      ...turnPersistence(this.plugin.conversations(), turn, turnMessages),
      registerTurn: (stop) => this.plugin.conversations().registerTurn(turn.conversationId, turn.turnId, () => {
        controller.abort();
        stop();
        if (this.currentTurn?.turnId === turn.turnId) {
          this.currentTurn = null;
          this.setSending(false);
        }
      }),
    });
    this.turnRenderUnsubscribe = this.transcript.startTurnRendering(turn.conversationId, bubble, body, wantThinking, turnService);
    const outcome = await handle.result.catch(() => undefined);
    // A capped turn keeps its receipt + handoff: show Continue, or chain the
    // next turn when auto-continue is on — only while this view shows the
    // conversation; a backgrounded turn waits for the user.
    if (!outcome?.capped || this.conversationId !== turn.conversationId) return true;
    const conversation = this.plugin.conversations().list().find((entry) => entry.id === turn.conversationId);
    if (!conversation || conversation.activeTurn?.state !== "capped") return true;
    this.transcript.renderInterruptedTurn(conversation);
    if (shouldAutoContinue(this.plugin.settings.agentAutoContinue, conversation.activeTurn)) await this.resumeInterruptedTurn(conversation);
    return true;
  }

  /** Push the chatFontSize setting onto the view as --cc-chat-font (drives .cc-body). */
  private applyChatFontSize(): void {
    this.containerEl.style.setProperty("--cc-chat-font", `${this.plugin.settings.chatFontSize}px`);
  }

  private async stopCurrentTurn(): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) {
      this.abort?.abort();
      return;
    }
    await this.plugin.conversations().stopTurn(turn.conversationId, turn.turnId);
  }

  async resumeInterruptedTurn(conversation: Conversation): Promise<void> {
    const receipt = conversation.activeTurn;
    const continuation = receipt ? continuationFor(receipt) : null;
    if (!receipt || !continuation) return;
    this.resumeCliSessionId = receipt.cliSessionId ?? conversation.cliSessionId ?? null;
    this.continuationDepth = continuation.depth;
    try {
      await this.run(continuation.prompt, continuation.display);
    } finally {
      this.resumeCliSessionId = null;
      this.continuationDepth = 0;
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
