import { ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import type { ChatMessage } from "../types";
import { compactMessages, toApiMessages, type Conversation } from "../conversations/store";
import { ConversationPicker } from "./ConversationPicker";
import { modelLabel, CLAUDE_MODELS, resolveModelId } from "../claude/models";
import { capabilitiesFor, effortLevels } from "../claude/capabilities";
import { type ChatControls, defaultChatControls, shapeRequest } from "../claude/chatControls";
import { shouldFallbackToLocal, fallbackReason } from "../providers/fallback";
import type { CompletionRequest } from "../providers/types";
import { SlashMenu } from "./SlashMenu";
import { type SlashCommand, SLASH_COMMANDS, parseSlashQuery } from "./slashCommands";
import { hasIncompleteHtmlArtifactFence, shouldRenderMarkdownDuringStream } from "./streamRender";
import { gatherContext, type AttachedPath } from "../context/vaultContext";
import { AtMenu } from "./AtMenu";
import { type AtItem, buildAtItems, activeAtQuery } from "../context/atMention";
import { extractArtifact, saveArtifactNote, saveChatNote, savePlanNote } from "../artifacts/artifactStore";
import { extractTasks } from "../build/spec";
import { errorHint } from "../providers/errorHints";
import { addUsage, contextGauge, EMPTY_SESSION, estimateTokens, formatCost, formatTokens, sessionCost, type SessionUsage } from "../usage/tokens";
import { mergeUsage, type TokenUsage } from "../claude/sse";

export const CHAT_VIEW_TYPE = "claude-companion-chat";

interface ObsidianAppWithSettings {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
}

export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private backendPillEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private gaugeFillEl!: HTMLElement;
  private streaming = false;
  private abort: AbortController | null = null;
  private session: SessionUsage = { ...EMPTY_SESSION };
  /** Usage for the in-flight turn; folded into the session once on completion. */
  private _turnUsage: TokenUsage | null = null;
  /** Per-session chat controls (model, thinking, effort, temp, max). */
  private controls!: ChatControls;
  private controlsEl!: HTMLElement;
  private knobsEl!: HTMLElement;
  private mcpStatusEl!: HTMLButtonElement;
  private atMenu!: AtMenu;
  private pillsEl!: HTMLElement;
  /** Notes/folders explicitly attached via "@" (session-scoped). */
  private attachedPaths: AttachedPath[] = [];
  /** Rotating "thinking" status word timer + per-turn start offset. */
  private thinkingTimer: number | null = null;
  private claudianSeq = 0;
  /** Per-turn max-output override (artifact/plan/workflow flows need headroom). */
  private maxTokensOverride: number | null = null;
  private contextStatusInterval: number | null = null;
  private lastMarkdownView: MarkdownView | null = null;
  private lastMarkdownFilePath: string | null = null;
  /** The last user message text, for the Regenerate action. */
  private lastUserText = "";
  private slashMenu!: SlashMenu;
  /** Latest streamed text of the in-flight turn (for clean abort handling). */
  private _lastBuffer = "";
  private renderVersions = new WeakMap<HTMLElement, number>();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: ClaudeCompanionPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return "Companion for Claude";
  }
  override getIcon(): string {
    return "sparkles";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-chat-root"); // establishes the container-query context (see styles.css)
    root.addClass("cc-root");

    // Initialize per-session controls from the settings default model.
    if (!this.controls) {
      this.controls = defaultChatControls(resolveModelId(this.plugin.settings.model, this.plugin.settings.customModel));
    }

    // ---- header ----
    const header = root.createDiv({ cls: "cc-header" });
    const title = header.createDiv({ cls: "cc-title" });
    title.createSpan({ cls: "cc-eyebrow", text: "COMPANION FOR CLAUDE" });
    this.modelLabelEl = title.createSpan({ cls: "cc-model" });
    this.backendPillEl = title.createSpan({ cls: "cc-backend-pill", attr: { "aria-label": "Chat backend / connectivity" } });
    const actions = header.createDiv({ cls: "cc-header-actions" });
    // One-shot actions (left group). These DO something on click.
    this.iconButton(actions, "plus", "New chat", () => this.clearChat());
    this.iconButton(actions, "history", "Resume a past conversation", () => this.openHistory());
    this.iconButton(actions, "wand-2", "Run a vault workflow (manifests, rollup, MOC…)", () => void this.plugin.openWorkflowPicker());
    this.iconButton(actions, "save", "Save chat to vault", () => void this.saveChat());
    if (this.plugin.settings.memoryEnabled && !Platform.isMobile) {
      // "import" reads as a one-shot pull-in, not a toggle — capture brings a
      // Claude Code session's transcript into the vault.
      this.iconButton(actions, "import", "Capture a Claude Code session into memory", () => void this.plugin.openSessionPicker());
    }
    // Divider: everything to the right is a stateful toggle/status (clay = on),
    // so the engage/disengage controls read apart from the actions above.
    actions.createDiv({ cls: "cc-actions-sep" });
    this.renderIngestToggle(actions);
    // MCP bridge status + menu now lives in the header (the old chip/status row
    // is gone — context is attached with "@" in the composer instead).
    this.mcpStatusEl = actions.createEl("button", { cls: "cc-icon-btn cc-mcp-btn", attr: { "aria-label": "MCP bridge controls" } });
    setIcon(this.mcpStatusEl, "plug-zap");
    this.mcpStatusEl.addEventListener("click", (evt) => this.openMcpMenu(evt));
    this.iconButton(actions, "settings", "Open settings", () => this.openSettings());

    // ---- messages ----
    // Chat controls now live at the bottom (in the composer), so the top stays
    // light and the reading area gets the space.
    this.messagesEl = root.createDiv({ cls: "cc-messages" });

    // ---- composer ----
    const composer = root.createDiv({ cls: "cc-composer" });

    // Attached-context pills (what "@" added). Lives above the input.
    this.pillsEl = composer.createDiv({ cls: "cc-attach-pills" });
    this.renderAttachPills();

    // Palettes anchored above the input (built before the textarea so they sit
    // above it in flow; CSS positions them absolutely).
    this.slashMenu = new SlashMenu(composer, SLASH_COMMANDS, (cmd) => void this.runSlashCommand(cmd));
    this.atMenu = new AtMenu(composer, () => this.atItems(), (item) => void this.onAtChoose(item));

    this.inputEl = composer.createEl("textarea", {
      cls: "cc-input",
      attr: { placeholder: "Ask Claude…  ( / for commands · @ to add context · Enter to send )", rows: "3" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      // The "@" picker intercepts navigation keys while open.
      if (this.atMenu.isOpen()) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.atMenu.move(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.atMenu.move(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this.atMenu.choose(); return; }
        if (e.key === "Escape") { e.preventDefault(); this.atMenu.hide(); return; }
      }
      // Slash menu intercepts navigation keys while open.
      if (this.slashMenu.isOpen()) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.slashMenu.move(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.slashMenu.move(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this.slashMenu.choose(); return; }
        if (e.key === "Escape") { e.preventDefault(); this.slashMenu.hide(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.onSend();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.autosizeInput();
      this.updateUsageBar();
      this.syncSlashMenu();
      this.syncAtMenu();
    });
    // Close the menus when focus leaves the composer.
    this.inputEl.addEventListener("blur", () => window.setTimeout(() => { this.slashMenu.hide(); this.atMenu.hide(); }, 120));

    // ---- composer bar: model + tune (left group) · usage + Send (right) ----
    // One row directly under the input, so Send sits right beneath the chat box.
    const bar = composer.createDiv({ cls: "cc-composer-bar" });
    this.controlsEl = bar.createDiv({ cls: "cc-controls" });
    this.renderControls();

    const sendGroup = bar.createDiv({ cls: "cc-send-group" });
    const usageRow = sendGroup.createDiv({ cls: "cc-usage" });
    const gauge = usageRow.createDiv({ cls: "cc-gauge", attr: { "aria-label": "Estimated context window used" } });
    this.gaugeFillEl = gauge.createDiv({ cls: "cc-gauge-fill" });
    this.usageEl = usageRow.createDiv({ cls: "cc-usage-text" });
    this.sendBtn = sendGroup.createEl("button", { cls: "cc-send", text: "Send" });
    this.sendBtn.addEventListener("click", () => void this.onSend());

    this.refreshModelLabel();
    void this.refreshBackendPill();
    void this.refreshContextStatus();
    if (this.contextStatusInterval !== null) window.clearInterval(this.contextStatusInterval);
    this.contextStatusInterval = window.setInterval(() => void this.refreshContextStatus(), 2000);
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
    this.abort?.abort();
    this.streaming = false;
    this.setSending(false);
    this.session = { ...EMPTY_SESSION };
    this.messages = compactMessages(conversation.messages);
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.renderEmptyState();
    } else {
      for (const m of this.messages) this.renderStoredMessage(m);
    }
    this.updateUsageBar();
    this.scrollToBottom();
  }

  /** Render one persisted message, including assistant action buttons. */
  private renderStoredMessage(m: ChatMessage): void {
    const bubble = this.messagesEl.createDiv({ cls: `cc-msg cc-${m.role}` });
    bubble.createDiv({ cls: "cc-role", text: m.role === "user" ? "You" : "Claude" });
    const body = bubble.createDiv({ cls: "cc-body" });
    void this.renderMarkdownInto(body, m.display ?? m.content);
    if (m.role === "assistant" && m.content.trim().length > 0) this.addAssistantActions(bubble, m.content);
  }

  /** Clear the panel to its empty state without altering stored history. */
  resetToEmpty(): void {
    this.abort?.abort();
    this.streaming = false;
    this.setSending(false);
    this.messages = [];
    this.session = { ...EMPTY_SESSION };
    this.messagesEl.empty();
    this.renderEmptyState();
    this.updateUsageBar();
  }

  openHistory(): void {
    const conversations = this.plugin.listConversations();
    if (conversations.length === 0) {
      new Notice("No saved conversations yet.");
      return;
    }
    new ConversationPicker(this.app, conversations, (chosen) => {
      void this.plugin.setActiveConversation(chosen.id).then((c) => {
        if (c) this.loadConversation(c);
      });
    }).open();
  }

  /**
   * Recompute the context gauge (estimated input + reserved output vs the
   * model's window) and render the running session totals. Called on input,
   * after each response, and when the model changes.
   */
  private updateUsageBar(): void {
    const { provider } = this.plugin.router().chatProvider();
    const model = provider.id === "ollama" ? this.plugin.settings.ollamaModel : this.controls?.model ?? this.plugin.settings.model;
    const reserved = this.controls?.maxTokens ?? this.plugin.settings.maxTokens;

    // Estimate input tokens: system + conversation so far + the draft + a
    // rough allowance for the vault context that will be attached.
    const convo = this.messages.map((m) => m.content).join("\n");
    const draft = this.inputEl?.value ?? "";
    const ctxAllowance = this.anyContextEnabled() ? this.plugin.settings.contextCharBudget : 0;
    const estIn = estimateTokens(this.plugin.composeSystemPrompt()) + estimateTokens(convo) + estimateTokens(draft) + estimateTokens("x".repeat(ctxAllowance));

    const g = contextGauge(estIn, model, reserved);
    this.gaugeFillEl.setCssStyles({ width: `${Math.round(g.fraction * 100)}%` });
    this.gaugeFillEl.toggleClass("is-warn", g.fraction >= 0.75 && g.fraction < 0.92);
    this.gaugeFillEl.toggleClass("is-danger", g.fraction >= 0.92);

    const parts: string[] = [];
    if (provider.id === "ollama") {
      parts.push(`~${formatTokens(estIn)} ctx · local (no metered cost)`);
    } else {
      parts.push(`~${formatTokens(estIn)} / ${formatTokens(g.window)} ctx`);
      // OAuth subscription tokens don't bill per-token, so show token totals
      // without a dollar estimate; API-key usage shows the estimated cost.
      const oauth = "isOAuth" in provider && (provider as { isOAuth(): boolean }).isOAuth();
      if (this.session.requests > 0) {
        const totals = `session ${formatTokens(this.session.inputTokens)}↑ ${formatTokens(this.session.outputTokens)}↓`;
        parts.push(oauth ? `${totals} · subscription` : `${totals} ≈ ${formatCost(sessionCost(this.session, model))}`);
      }
    }
    this.usageEl.setText(parts.join("  ·  "));
  }

  private anyContextEnabled(): boolean {
    const c = this.plugin.settings.context;
    return c.activeNote || c.selection || c.linkedNotes || c.searchVault || this.attachedPaths.length > 0;
  }

  override async onClose(): Promise<void> {
    this.abort?.abort();
    this.clearThinkingStatus();
    if (this.contextStatusInterval !== null) {
      window.clearInterval(this.contextStatusInterval);
      this.contextStatusInterval = null;
    }
  }

  refreshModelLabel(): void {
    const { provider } = this.plugin.router().chatProvider();
    const model = provider.id === "ollama" ? this.plugin.settings.ollamaModel : this.controls?.model ?? this.plugin.settings.model;
    const label = provider.id === "ollama" ? `${model} · local` : modelLabel(model);
    this.modelLabelEl.setText(label);
    if (this.usageEl) this.updateUsageBar();
  }

  // ---------- public entry point (used by commands) ----------

  async submitPrompt(text: string, display?: string, maxTokens?: number): Promise<void> {
    if (!text.trim() || this.streaming) return;
    this.inputEl.value = "";
    await this.run(text.trim(), display, maxTokens);
  }

  // ---------- UI helpers ----------

  private iconButton(parent: HTMLElement, icon: string, tip: string, onClick: () => void): void {
    const btn = parent.createEl("button", { cls: "cc-icon-btn", attr: { "aria-label": tip } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
  }

  /**
   * An icon toggle (matches the other header icon buttons) that mirrors the
   * persisted "ingest on save" setting. Active = clay highlight.
   */
  private renderIngestToggle(parent: HTMLElement): void {
    if (!this.plugin.settings.memoryEnabled || Platform.isMobile) return;
    const btn = parent.createEl("button", {
      cls: "cc-icon-btn cc-icon-toggle",
      attr: { "aria-label": "Also file this conversation into session memory when saving" },
    });
    setIcon(btn, "archive");
    const sync = () => {
      const on = this.plugin.settings.memoryIngestOnSave;
      btn.toggleClass("is-active", on);
      btn.setAttr("aria-pressed", String(on));
    };
    sync();
    btn.addEventListener("click", () => {
      this.plugin.settings.memoryIngestOnSave = !this.plugin.settings.memoryIngestOnSave;
      sync();
      void this.plugin.saveSettings();
    });
  }

  // ---------- "@" context picker ----------

  /** Candidate sources for the "@" menu: 4 specials + vault notes + folders. */
  private atItems(): AtItem[] {
    const notes = this.app.vault.getMarkdownFiles().map((f) => f.path);
    const folders = new Set<string>();
    for (const p of notes) {
      const i = p.lastIndexOf("/");
      if (i > 0) folders.add(p.slice(0, i));
    }
    return buildAtItems(notes, [...folders].sort());
  }

  /** Open/refresh/close the "@" picker based on the cursor's @-token. */
  private syncAtMenu(): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const hit = activeAtQuery(this.inputEl.value, cursor);
    if (!hit) this.atMenu.hide();
    else this.atMenu.show(hit.query);
  }

  /** Apply a chosen "@" source: toggle a context flag or attach a note/folder. */
  private async onAtChoose(item: AtItem): Promise<void> {
    // Strip the "@query" token the user typed.
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const hit = activeAtQuery(this.inputEl.value, cursor);
    if (hit) {
      const v = this.inputEl.value;
      this.inputEl.value = v.slice(0, hit.start) + v.slice(cursor);
      this.inputEl.setSelectionRange(hit.start, hit.start);
    }
    this.inputEl.focus();

    if (item.kind === "note") this.plugin.settings.context.activeNote = true;
    else if (item.kind === "selection") this.plugin.settings.context.selection = true;
    else if (item.kind === "linked") this.plugin.settings.context.linkedNotes = true;
    else if (item.kind === "vault") this.plugin.settings.context.searchVault = true;
    else if (item.path && (item.kind === "note-path" || item.kind === "folder-path")) {
      const kind = item.kind === "folder-path" ? "folder" : "note";
      if (!this.attachedPaths.some((a) => a.path === item.path && a.kind === kind)) {
        this.attachedPaths.push({ path: item.path, kind });
      }
    }
    await this.plugin.saveSettings();
    this.renderAttachPills();
    this.updateUsageBar();
  }

  /** Render the attached-context pills (enabled flags + @-attached paths). */
  private renderAttachPills(): void {
    if (!this.pillsEl) return;
    this.pillsEl.empty();
    const c = this.plugin.settings.context;
    const active = this.resolveMarkdownContextView()?.file ?? this.app.workspace.getActiveFile();

    const pill = (label: string, onRemove: () => void) => {
      const el = this.pillsEl.createDiv({ cls: "cc-attach-pill" });
      el.createSpan({ cls: "cc-attach-label", text: label });
      const x = el.createEl("button", { cls: "cc-attach-x", attr: { "aria-label": `Remove ${label}` }, text: "×" });
      x.addEventListener("click", () => {
        onRemove();
        void this.plugin.saveSettings();
        this.renderAttachPills();
        this.updateUsageBar();
      });
    };

    if (c.activeNote) pill(active ? `📄 ${active.basename}` : "📄 This note", () => (c.activeNote = false));
    if (c.selection) pill("✂️ Selection", () => (c.selection = false));
    if (c.linkedNotes) pill("🔗 Linked notes", () => (c.linkedNotes = false));
    if (c.searchVault) pill("🔍 Entire vault", () => (c.searchVault = false));
    for (const a of this.attachedPaths) {
      const base = a.path.replace(/\.md$/i, "").split("/").pop() ?? a.path;
      pill(`${a.kind === "folder" ? "📁" : "📄"} ${base}`, () => {
        this.attachedPaths = this.attachedPaths.filter((x) => !(x.path === a.path && x.kind === a.kind));
      });
    }
    this.pillsEl.toggleClass("is-empty", this.pillsEl.childElementCount === 0);
  }

  /**
   * Render the per-message control row. The visible knobs adapt to the selected
   * model's capabilities, so a control that the model would 400 on is hidden
   * rather than shown-and-broken. Ollama (local) sessions show no Claude knobs.
   */
  private renderControls(): void {
    this.controlsEl.empty();

    // The model switcher is built ONCE here and never destroyed on knob changes,
    // so picking a model doesn't flicker or drop focus. Only `knobsEl` rebuilds.
    const modelWrap = this.controlsEl.createDiv({ cls: "cc-ctl cc-ctl-model" });
    const select = modelWrap.createEl("select", { cls: "cc-ctl-select", attr: { "aria-label": "Model" } });
    const claudeGroup = select.createEl("optgroup", { attr: { label: "Claude" } });
    const ids = new Set(CLAUDE_MODELS.map((m) => m.id));
    for (const m of CLAUDE_MODELS) claudeGroup.createEl("option", { value: m.id, text: m.label });
    if (!ids.has(this.controls.model)) claudeGroup.createEl("option", { value: this.controls.model, text: this.controls.model });
    select.value = this.controls.model;
    select.addEventListener("change", () => void this.onModelSelect(select.value));
    // Pull in detected Ollama models so a local model can be picked here without
    // opening settings. Async — appended once the local server answers.
    void this.appendLocalModelOptions(select);

    // Knobs (thinking / effort / temp / max) live in a popover behind a single
    // "tune" button, so the footer stays clean and Send is never buried.
    const tuneWrap = this.controlsEl.createDiv({ cls: "cc-tune" });
    const tuneBtn = tuneWrap.createEl("button", {
      cls: "cc-icon-btn cc-tune-btn",
      attr: { "aria-label": "Model controls — thinking, temperature, max tokens", "aria-expanded": "false" },
    });
    setIcon(tuneBtn, "sliders-horizontal");
    this.knobsEl = tuneWrap.createDiv({ cls: "cc-knobs cc-knobs-popover" });
    this.renderKnobs();
    tuneBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !this.knobsEl.hasClass("is-open");
      this.knobsEl.toggleClass("is-open", open);
      tuneBtn.setAttr("aria-expanded", String(open));
    });
    // Close the popover on an outside click (auto-cleaned with the view).
    this.registerDomEvent(activeDocument, "click", (e) => {
      if (this.knobsEl?.hasClass("is-open") && !tuneWrap.contains(e.target as Node)) {
        this.knobsEl.removeClass("is-open");
        tuneBtn.setAttr("aria-expanded", "false");
      }
    });
  }

  /** Append an "Local (Ollama)" optgroup of detected models to the switcher. */
  private async appendLocalModelOptions(select: HTMLSelectElement): Promise<void> {
    let models: string[] = [];
    try {
      models = await this.plugin.router().ollama.listModels();
    } catch {
      return; // local server unreachable — Claude-only switcher
    }
    const configured = this.plugin.settings.ollamaModel;
    if (configured && !models.includes(configured)) models = [configured, ...models];
    if (!models.length || !select.isConnected) return;
    const group = select.createEl("optgroup", { attr: { label: "Local (Ollama)" } });
    for (const m of models) group.createEl("option", { value: `ollama:${m}`, text: `${m} · local` });
    // Now that local options exist, reflect the active backend in the selection.
    if (this.plugin.settings.chatBackend === "local" && configured) select.value = `ollama:${configured}`;
  }

  /**
   * Apply a model-switcher choice. Picking a `ollama:<model>` entry routes the
   * chat to that local model (backend → local); picking a Claude model routes
   * back to Claude (backend → auto, so it still falls back to local when needed).
   */
  private async onModelSelect(value: string): Promise<void> {
    if (value.startsWith("ollama:")) {
      this.plugin.settings.ollamaModel = value.slice("ollama:".length);
      this.plugin.settings.chatBackend = "local";
    } else {
      this.controls.model = value;
      if (this.plugin.settings.chatBackend === "local") this.plugin.settings.chatBackend = "auto";
    }
    await this.plugin.saveSettings();
    this.renderKnobs(); // capabilities/provider changed → rebuild dependent knobs
    this.refreshModelLabel();
    this.updateUsageBar();
    void this.refreshBackendPill();
  }

  /** Rebuild only the capability-dependent knobs (keeps the model select stable). */
  private renderKnobs(): void {
    if (!this.knobsEl) return;
    this.knobsEl.empty();
    const parent = this.knobsEl;

    if (this.plugin.router().chatProvider().provider.id === "ollama") {
      parent.createSpan({ cls: "cc-ctl-note", text: "local model · Claude controls apply when routed to Claude" });
      return;
    }

    const caps = capabilitiesFor(this.controls.model);

    if (caps.thinking !== "none") {
      const think = parent.createEl("button", { cls: "cc-ctl cc-ctl-toggle", text: "Think", attr: { "aria-label": "Extended thinking" } });
      think.toggleClass("is-active", this.controls.thinking);
      think.addEventListener("click", () => {
        this.controls.thinking = !this.controls.thinking;
        this.renderKnobs();
        this.updateUsageBar();
      });

      if (caps.effort && this.controls.thinking) {
        const eff = parent.createEl("select", { cls: "cc-ctl cc-ctl-select", attr: { "aria-label": "Effort" } });
        for (const level of effortLevels(caps)) eff.createEl("option", { value: level, text: `effort: ${level}` });
        if (!effortLevels(caps).includes(this.controls.effort)) this.controls.effort = "high";
        eff.value = this.controls.effort;
        eff.addEventListener("change", () => {
          this.controls.effort = eff.value;
        });
      }

      if (caps.thinking === "adaptive" && this.controls.thinking) {
        const show = parent.createEl("button", { cls: "cc-ctl cc-ctl-toggle", text: "Show reasoning" });
        show.toggleClass("is-active", this.controls.showThinking);
        show.addEventListener("click", () => {
          this.controls.showThinking = !this.controls.showThinking;
          show.toggleClass("is-active", this.controls.showThinking);
        });
      }
    }

    if (caps.temperature && !this.controls.thinking) {
      const tempWrap = parent.createDiv({ cls: "cc-ctl cc-ctl-temp", attr: { "aria-label": "Temperature (double-click to reset)" } });
      tempWrap.createSpan({ cls: "cc-ctl-label", text: "temp" });
      const temp = tempWrap.createEl("input", {
        cls: "cc-ctl-range",
        attr: { type: "range", min: "0", max: "1", step: "0.1", "aria-label": "Temperature" },
      });
      const out = tempWrap.createSpan({ cls: "cc-ctl-val" });
      const sync = () => out.setText(this.controls.temperature === null ? "auto" : this.controls.temperature.toFixed(1));
      temp.value = String(this.controls.temperature ?? 0.7);
      sync();
      temp.addEventListener("input", () => {
        this.controls.temperature = parseFloat(temp.value);
        sync();
      });
      tempWrap.addEventListener("dblclick", () => {
        this.controls.temperature = null;
        sync();
      });
    }

    const maxWrap = parent.createDiv({ cls: "cc-ctl cc-ctl-max" });
    maxWrap.createSpan({ cls: "cc-ctl-label", text: "max" });
    const maxIn = maxWrap.createEl("input", {
      cls: "cc-ctl-num",
      attr: { type: "number", min: "1", placeholder: String(this.plugin.settings.maxTokens), "aria-label": "Max output tokens" },
    });
    if (this.controls.maxTokens) maxIn.value = String(this.controls.maxTokens);
    maxIn.addEventListener("change", () => {
      const n = parseInt(maxIn.value, 10);
      this.controls.maxTokens = Number.isFinite(n) && n > 0 ? n : null;
      this.updateUsageBar();
    });
  }

  private renderEmptyState(): void {
    if (this.messages.length > 0) return;
    this.messagesEl.empty();
    const empty = this.messagesEl.createDiv({ cls: "cc-empty" });
    setIcon(empty.createDiv({ cls: "cc-empty-icon" }), "sparkles");
    empty.createDiv({ cls: "cc-empty-title", text: "Claude, in your vault." });
    empty.createDiv({
      cls: "cc-empty-sub",
      text: "Type @ to bring in a note, your selection, or the whole vault — then try one of these, or just ask.",
    });
    const examples: { label: string; prompt: string }[] = [
      { label: "📋 Summarize my active note", prompt: "Summarize my active note as concise bullet points with the key takeaways first." },
      { label: "📊 Turn this into a dashboard", prompt: "Turn my current note into a single beautiful, self-contained interactive dashboard artifact using the design system." },
      { label: "🗺️ Plan a feature", prompt: "Help me plan a feature. Ask me clarifying questions first, then produce an implementation plan." },
      { label: "🔍 Ask across my vault", prompt: "Search my vault and answer: what have I written about " },
    ];
    const grid = empty.createDiv({ cls: "cc-empty-examples" });
    for (const ex of examples) {
      const card = grid.createEl("button", { cls: "cc-example", text: ex.label });
      card.addEventListener("click", () => {
        this.inputEl.value = ex.prompt;
        this.inputEl.focus();
        this.autosizeInput();
        this.updateUsageBar();
        // A trailing-space prompt (the vault-search one) waits for the user to type.
        if (!ex.prompt.endsWith(" ")) void this.onSend();
      });
    }
  }

  clearChat(): void {
    this.abort?.abort();
    this.streaming = false;
    this.messages = [];
    this.session = { ...EMPTY_SESSION };
    // The previous conversation is already auto-saved; detach so the next turn
    // begins a fresh session.
    void this.plugin.startNewConversation();
    this.attachedPaths = [];
    this.renderAttachPills();
    this.messagesEl.empty();
    this.renderEmptyState();
    this.setSending(false);
    this.updateUsageBar();
  }

  private openSettings(): void {
    const setting = (this.app as ObsidianAppWithSettings).setting;
    setting?.open?.();
    setting?.openTabById?.("claude-companion");
  }

  // ---------- send / stream ----------

  private async onSend(): Promise<void> {
    if (this.streaming) {
      this.abort?.abort();
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.lastUserText = text;
    this.inputEl.value = "";
    this.autosizeInput();
    await this.run(text);
  }

  /** Grow the composer with its content (1→~8 rows), then stop and scroll. */
  private autosizeInput(): void {
    const el = this.inputEl;
    if (!el) return;
    el.setCssStyles({ height: "auto" });
    const max = 200; // px ceiling (~8 rows) before it scrolls internally
    el.setCssStyles({ height: `${Math.min(el.scrollHeight, max)}px` });
  }

  /** Open/refresh/close the slash palette based on the current input. */
  private syncSlashMenu(): void {
    const q = parseSlashQuery(this.inputEl.value);
    if (q === null) this.slashMenu.hide();
    else this.slashMenu.show(q);
  }

  /** Execute a chosen slash command — either send a prompt or run an action. */
  private async runSlashCommand(cmd: SlashCommand): Promise<void> {
    this.inputEl.value = "";
    this.autosizeInput();

    if (cmd.kind === "prompt" && cmd.prompt) {
      if (cmd.awaitsInput) {
        // Insert the template and let the user finish typing (e.g. "/explain ").
        this.inputEl.value = cmd.prompt;
        this.inputEl.focus();
        this.autosizeInput();
        this.updateUsageBar();
        return;
      }
      // Hide the verbose template behind the command name; the model still gets cmd.prompt.
      await this.submitPrompt(cmd.prompt, `/${cmd.name}`);
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
      case "capture-memory":
        await this.plugin.openSessionPicker();
        break;
      case "history":
        this.openHistory();
        break;
      case "save":
        await this.saveChat();
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
        new Notice("Vault search enabled for your next message.");
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
    this.sendBtn.setText(sending ? "Stop" : "Send");
    this.sendBtn.toggleClass("is-stop", sending);
    this.sendBtn.setAttr("aria-label", sending ? "Stop generating" : "Send message");
  }

  private async run(userText: string, display?: string, maxTokens?: number): Promise<void> {
    this.maxTokensOverride = maxTokens ?? null; // reset each turn
    const router = this.plugin.router();
    const { provider } = router.chatProvider();
    const backend = router.chatBackend;
    if (!provider.hasCredentials() && backend !== "auto") {
      const where = provider.id === "ollama" ? "Start Ollama (`ollama serve`) or set the host in settings." : "Add your Anthropic credential in Claude Companion settings first.";
      new Notice(where);
      return;
    }

    this.messages.push({ role: "user", content: userText, ...(display !== undefined ? { display } : {}) });
    this.renderMessage("user", display ?? userText);

    // Build context-augmented copy of the message list for the API.
    const ctx = await gatherContext(
      this.app,
      this.plugin.settings,
      this.plugin.settings.context,
      userText,
      (q, k) => this.plugin.semanticSearch(q, k),
      this.attachedPaths,
    );
    const apiMessages: ChatMessage[] = toApiMessages(this.messages);
    if (ctx.text) {
      const last = apiMessages[apiMessages.length - 1];
      if (last) last.content = `${ctx.text}\n\n---\n\n${last.content}`;
      this.annotateContext(ctx.sources);
    }

    const { bubble, body } = this.createAssistantBubble();
    this.setSending(true);
    this.abort = new AbortController();
    this._turnUsage = null;

    // Attempt #1 on the primary backend (Claude unless backend is "local").
    const startedOnLocal = provider.id === "ollama";
    const err1 = await this.streamTurn(startedOnLocal ? "local" : "claude", apiMessages, bubble, body);

    // Fallback: if Claude failed with an offline/usage error and a local model is
    // available, retry transparently so you keep working with no internet/tokens.
    if (err1) {
      const localOk = await router.localAvailable();
      const doFallback = shouldFallbackToLocal({ backend, localAvailable: localOk, error: err1 });
      if (doFallback) {
        this.annotateFallback(bubble, fallbackReason(err1));
        const err2 = await this.streamTurn("local", apiMessages, bubble, body);
        if (err2) {
          this.renderError(body, err2.message ?? "Request failed");
          this.finishAssistant(null, bubble);
        }
      } else {
        this.renderError(body, err1.message ?? "Request failed");
        this.finishAssistant(null, bubble);
      }
    }

    // If a stream ended without onDone (usually an abort), keep ordinary text
    // recoverable but never persist a half-generated HTML artifact fence.
    if (this.streaming) {
      if (this._lastBuffer && hasIncompleteHtmlArtifactFence(this._lastBuffer)) {
        this.renderInterruptedArtifact(body);
        this.finishAssistant(null, bubble);
      } else {
        this.finishAssistant(this._lastBuffer || null, bubble);
      }
    }
  }

  /**
   * Run one streaming attempt on a backend. Resolves to the error if it failed
   * (for the fallback decision), or null on success (onDone fired). The answer
   * and reasoning render into the passed bubble/body.
   */
  private streamTurn(
    target: "claude" | "local",
    apiMessages: ChatMessage[],
    bubble: HTMLElement,
    body: HTMLElement,
  ): Promise<{ message?: string; status?: number } | null> {
    const router = this.plugin.router();
    const onClaude = target === "claude";
    const provider = onClaude ? router.anthropic : router.ollama;
    const model = onClaude ? this.controls.model : this.plugin.settings.ollamaModel;
    const shape = shapeRequest({ ...this.controls, model: onClaude ? model : this.controls.model }, this.maxTokensOverride ?? this.plugin.settings.maxTokens);
    const wantThinking = onClaude && this.controls.thinking && this.controls.showThinking;
    let thinkingBody: HTMLElement | null = wantThinking ? this.createThinkingPanel(bubble) : null;

    let buffer = "";
    let thinkBuf = "";
    let scheduled = false;
    let finalizing = false;
    // Throttle the (expensive) full markdown re-render during streaming. Rendering
    // every animation frame swaps the whole subtree via replaceChildren ~60×/s,
    // which reads as flicker. ~100ms keeps it lively without churn; onDone always
    // does a final authoritative render, and skipped frames just keep the last
    // paint (the next delta reschedules a flush, so content never stalls visibly).
    const MD_THROTTLE_MS = 100;
    let lastMd = 0;
    const flush = () => {
      scheduled = false;
      if (finalizing) return;
      if (shouldRenderMarkdownDuringStream(buffer)) {
        const now = performance.now();
        if (now - lastMd < MD_THROTTLE_MS) return; // skip; next delta reschedules
        lastMd = now;
        void this.renderMarkdownInto(body, buffer);
      } else {
        this.renderStreamingTextInto(body, buffer);
      }
      this.scrollToBottom();
    };

    return new Promise((resolve) => {
      let settled = false;
      const request: CompletionRequest = {
        system: this.plugin.composeSystemPrompt(),
        messages: apiMessages,
        model,
        maxTokens: shape.maxTokens,
      };
      if (onClaude && shape.temperature !== undefined) request.temperature = shape.temperature;
      if (onClaude && shape.thinking !== undefined) request.thinking = shape.thinking;
      if (onClaude && shape.thinkingDisplay !== undefined) request.thinkingDisplay = shape.thinkingDisplay;
      if (onClaude && shape.outputConfig !== undefined) request.outputConfig = shape.outputConfig;
      if (this.abort?.signal) request.signal = this.abort.signal;
      void provider.stream(
        request,
        {
          onThinking: (delta) => {
            if (!thinkingBody) thinkingBody = this.createThinkingPanel(bubble);
            thinkBuf += delta;
            thinkingBody.setText(thinkBuf);
            this.scrollToBottom();
          },
          onText: (delta) => {
            if (buffer === "") this.clearThinkingStatus(); // first token landed
            buffer += delta;
            this._lastBuffer = buffer;
            if (!scheduled) {
              scheduled = true;
              window.requestAnimationFrame(flush);
            }
          },
          onError: (err) => {
            if (settled) return;
            settled = true;
            const status = (err as { status?: number }).status;
            resolve(status !== undefined ? { message: err.message, status } : { message: err.message });
          },
          onUsage: (usage) => {
            this._turnUsage = mergeUsage(this._turnUsage ?? undefined, usage);
          },
          onTruncated: () => this.annotateTruncated(bubble),
          onDone: (full) => {
            if (settled) return;
            settled = true;
            finalizing = true;
            buffer = full;
            this._lastBuffer = full;
            void this.renderMarkdownInto(body, full).then(() => {
              this.finishAssistant(full, bubble);
              resolve(null);
            });
          },
        },
      ).then(() => {
        // stream() resolved without onError/onDone (e.g. aborted) — not an error.
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }

  private finishAssistant(full: string | null, bubble: HTMLElement): void {
    // Idempotent per bubble: onDone and the abort-safety net can both reach here
    // for the same turn — only the first call commits the message + action bar.
    if (bubble.dataset.ccFinished === "1") return;
    bubble.dataset.ccFinished = "1";
    this.clearThinkingStatus(); // covers no-text / error / abort turns
    this.setSending(false);
    this.abort = null;
    if (full && full.trim().length > 0) {
      this.messages.push({ role: "assistant", content: full });
      this.addAssistantActions(bubble, full);
    }
    // Persist the turn so the conversation survives a restart (best-effort).
    void this.plugin.saveActiveConversation(this.messages);
    // Fold this turn's usage into the session exactly once. The API emits usage
    // on both message_start and message_delta; counting each event would double
    // the request count and inflate output tokens.
    if (this._turnUsage) {
      this.session = addUsage(this.session, this._turnUsage);
      this._turnUsage = null;
    }
    this.updateUsageBar();
    this.scrollToBottom();
  }

  // ---------- rendering ----------

  private createAssistantBubble(): { bubble: HTMLElement; body: HTMLElement } {
    const bubble = this.messagesEl.createDiv({ cls: "cc-msg cc-assistant" });
    bubble.createDiv({ cls: "cc-role", text: "Claude" });
    const body = bubble.createDiv({ cls: "cc-body" });
    // One indicator only: the breathing smiley in the thinking status. (The old
    // "▍" cursor was a second clay marker fighting it.)
    this.startThinkingStatus(body);
    this.scrollToBottom();
    return { bubble, body };
  }

  /** Playful "Claudian" gerunds shown while Claude works, before text arrives. */
  private static readonly CLAUDIAN = [
    "Manifesting", "Synthesizing", "Philosophising", "Pondering",
    "Actualizing", "Synergizing", "Ruminating", "Clauding",
  ];

  /**
   * Show a single breathing smiley on the left with a whimsical word cycling
   * beside it until the first token lands. The smiley is fixed-position so the
   * word's changing length never shifts it. The smiley pulses 4× per word-fade
   * cycle (80 bpm vs 20 bpm) — driven by CSS; the word swaps on the fade trough.
   */
  private startThinkingStatus(body: HTMLElement): void {
    const status = body.createSpan({ cls: "cc-thinking-status" });
    setIcon(status.createSpan({ cls: "cc-thinking-dot" }), "smile");
    const word = status.createSpan({ cls: "cc-thinking-word" });
    let i = this.claudianSeq++;
    const tick = () => {
      word.setText(`${ChatView.CLAUDIAN[i % ChatView.CLAUDIAN.length]}…`);
      i++;
    };
    tick();
    this.clearThinkingStatus();
    // 3000ms = the 20-bpm word-fade period, so the swap lands at the fade trough.
    this.thinkingTimer = window.setInterval(tick, 3000);
  }

  private clearThinkingStatus(): void {
    if (this.thinkingTimer != null) {
      window.clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  /**
   * Insert a collapsible reasoning panel before the answer body. Returns the
   * element that thinking text is streamed into. Inserted once per turn.
   */
  private createThinkingPanel(bubble: HTMLElement): HTMLElement {
    const details = bubble.createEl("details", { cls: "cc-thinking" });
    details.setAttr("open", "");
    details.createEl("summary", { cls: "cc-thinking-summary", text: "Reasoning" });
    const pre = details.createEl("pre", { cls: "cc-thinking-body" });
    // Place the panel right after the role label, above the answer body.
    const body = bubble.querySelector(".cc-body");
    if (body) bubble.insertBefore(details, body);
    return pre;
  }

  private renderMessage(role: "user" | "assistant", text: string): void {
    if (this.messages.length === 1) this.messagesEl.empty();
    const bubble = this.messagesEl.createDiv({ cls: `cc-msg cc-${role}` });
    bubble.createDiv({ cls: "cc-role", text: role === "user" ? "You" : "Claude" });
    const body = bubble.createDiv({ cls: "cc-body" });
    void this.renderMarkdownInto(body, text);
    this.scrollToBottom();
  }

  private renderError(body: HTMLElement, message: string): void {
    body.empty();
    const box = body.createDiv({ cls: "cc-error" });
    box.createSpan({ cls: "cc-error-title", text: "Couldn’t reach the model" });
    box.createSpan({ text: message });
    const hint = errorHint(message);
    if (hint) box.createDiv({ cls: "cc-error-hint", text: hint });
  }

  /** Flag a reply that the model truncated at the output-token limit. */
  private annotateTruncated(bubble: HTMLElement): void {
    if (bubble.querySelector(".cc-truncated-note")) return;
    const note = bubble.createDiv({ cls: "cc-truncated-note" });
    note.createSpan({ cls: "cc-truncated-title", text: "Response hit the output-token limit" });
    note.createSpan({
      text: ` — it was cut off. Raise “max” (top of the chat) and Regenerate for the full result. Current cap: ${this.controls?.maxTokens ?? this.plugin.settings.maxTokens} tokens.`,
    });
  }

  private renderInterruptedArtifact(body: HTMLElement): void {
    body.empty();
    const box = body.createDiv({ cls: "cc-error" });
    box.createSpan({ cls: "cc-error-title", text: "Artifact generation stopped" });
    box.createSpan({ text: "The HTML block did not finish, so it was not saved to the chat history." });
  }

  private annotateContext(sources: string[]): void {
    if (sources.length === 0) return;
    const last = this.messagesEl.lastElementChild;
    if (!last) return;
    last.createDiv({ cls: "cc-context-note", text: `+ context: ${sources.join(", ")}` });
  }

  /**
   * Update the header backend pill: shows the active mode and, for auto/local,
   * whether a local model is reachable (so you can see your offline safety net
   * at a glance). Best-effort and never throws.
   */
  async refreshBackendPill(): Promise<void> {
    if (!this.backendPillEl) return;
    const router = this.plugin.router();
    const backend = router.chatBackend;
    const el = this.backendPillEl;
    el.removeClass("is-ok", "is-warn");
    if (backend === "claude") {
      el.setText("");
      el.toggleClass("is-ok", false);
      return;
    }
    const localOk = await router.localAvailable();
    if (backend === "local") {
      el.setText(localOk ? "● local" : "● local offline");
      el.toggleClass("is-ok", localOk);
      el.toggleClass("is-warn", !localOk);
    } else {
      // auto
      el.setText(localOk ? "● auto · local ready" : "● auto · no local");
      el.toggleClass("is-ok", localOk);
      el.toggleClass("is-warn", !localOk);
    }
  }

  async refreshContextStatus(): Promise<void> {
    // Refresh the "This note" pill label as you navigate, and the MCP header icon.
    this.renderAttachPills();
    if (!this.mcpStatusEl) return;
    const mcp = this.plugin.mcpStats();
    const title = mcp.running
      ? mcp.activeRequests > 0
        ? `MCP bridge — ${mcp.activeRequests} active`
        : "MCP bridge — ready"
      : "MCP bridge — off";
    this.mcpStatusEl.setAttr("aria-label", title);
    this.mcpStatusEl.toggleClass("is-on", mcp.running);
    this.mcpStatusEl.toggleClass("is-warn", this.plugin.settings.mcpEnabled && !mcp.running);
  }

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

  private openMcpMenu(evt: MouseEvent): void {
    const stats = this.plugin.mcpStats();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(stats.running ? "Disconnect MCP bridge" : "Connect MCP bridge")
        .setIcon(stats.running ? "unlink" : "link")
        .onClick(async () => {
          await this.plugin.setMcpEnabled(!stats.running);
          await this.refreshContextStatus();
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Open MCP settings")
        .setIcon("settings")
        .onClick(() => this.openSettings());
    });
    menu.showAtMouseEvent(evt);
  }

  /** Note in the assistant bubble that we fell back to the local model. */
  private annotateFallback(bubble: HTMLElement, reason: string): void {
    bubble.createDiv({
      cls: "cc-fallback-note",
      text: `${reason} — answered locally with ${this.plugin.settings.ollamaModel}.`,
    });
  }

  private async renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void> {
    const version = this.bumpRenderVersion(el);
    el.removeClass("cc-streaming-raw");
    const rendered = activeDocument.createElement("div");
    await MarkdownRenderer.render(this.app, markdown, rendered, this.app.workspace.getActiveFile()?.path ?? "", this);
    if (this.renderVersions.get(el) !== version) return;
    el.replaceChildren(...Array.from(rendered.childNodes));
  }

  private renderStreamingTextInto(el: HTMLElement, text: string): void {
    this.bumpRenderVersion(el);
    el.addClass("cc-streaming-raw");
    el.textContent = text;
  }

  private bumpRenderVersion(el: HTMLElement): number {
    const version = (this.renderVersions.get(el) ?? 0) + 1;
    this.renderVersions.set(el, version);
    return version;
  }

  private addAssistantActions(bubble: HTMLElement, full: string): void {
    bubble.querySelectorAll(":scope > .cc-actions").forEach((el) => el.remove());
    // Per-code-block copy buttons inside the rendered markdown.
    this.decorateCodeBlocks(bubble);

    const bar = bubble.createDiv({ cls: "cc-actions" });
    this.actionBtn(bar, "Copy", "copy", () => {
      void navigator.clipboard.writeText(full);
      new Notice("Copied to clipboard");
    });
    this.actionBtn(bar, "Insert", "text-cursor-input", () => this.insertIntoNote(full));
    // One Save button that adapts to the content: an artifact saves as an inline
    // `claude-html` note (accented to stand out), anything else saves as a plain
    // chat note. (These used to be two separate buttons running the same handler.)
    const isArtifact = !!extractArtifact(full);
    const saveBtn = this.actionBtn(
      bar,
      isArtifact ? "Save artifact" : "Save as note",
      isArtifact ? "layout-dashboard" : "save",
      () => void this.saveReplyAsNote(full),
    );
    if (isArtifact) saveBtn.addClass("cc-accent");
    // A plan reply (has a `## Build tasks` checklist) gets a Build button right here.
    if (extractTasks(full).length > 0) {
      this.actionBtn(bar, "Build", "hammer", () => void this.buildFromReply(full));
    }
    // Regenerate the last reply (only on the most recent assistant message).
    const tail = this.messages[this.messages.length - 1];
    const isLast = tail?.role === "assistant";
    if (isLast && this.lastUserText) {
      this.actionBtn(bar, "Regenerate", "refresh-cw", () => void this.regenerate());
    }
  }

  /** Save a plan reply as a `type: plan` note, then hand it to the build flow. */
  private async buildFromReply(full: string): Promise<void> {
    const artifact = extractArtifact(full);
    const { tags, summary, title } = await this.maybeIndex(full);
    const planTitle = title ?? artifact?.title ?? this.fallbackTitle();
    const file = await savePlanNote(this.app, this.plugin.settings.planFolder, planTitle, full, {
      extraTags: tags,
      ...(summary !== undefined ? { summary } : {}),
    });
    await this.plugin.handoffToBuild(file);
  }

  /** Add a hover "copy" button to each <pre><code> block in a rendered reply. */
  private decorateCodeBlocks(bubble: HTMLElement): void {
    bubble.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".cc-code-copy")) return; // already decorated
      const el = pre as HTMLElement;
      el.addClass("cc-has-copy");
      const btn = el.createEl("button", { cls: "cc-code-copy", text: "Copy", attr: { "aria-label": "Copy code" } });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        void navigator.clipboard.writeText(code);
        btn.setText("Copied!");
        window.setTimeout(() => btn.setText("Copy"), 1200);
      });
    });
  }

  /** Drop the last assistant reply and re-run the previous user turn. */
  private async regenerate(): Promise<void> {
    if (this.streaming || !this.lastUserText) return;
    // Remove the trailing assistant message from state + DOM, plus the user msg
    // (run() re-pushes it). Then re-run with the same text.
    if (this.messages[this.messages.length - 1]?.role === "assistant") this.messages.pop();
    if (this.messages[this.messages.length - 1]?.role === "user") this.messages.pop();
    // Rebuild the transcript cleanly so we don't leave a stale bubble.
    this.messagesEl.empty();
    if (this.messages.length === 0) this.renderEmptyState();
    else for (const m of this.messages) this.renderStoredMessage(m);
    await this.run(this.lastUserText);
  }

  /**
   * Index a document for durable storage: tags + a one-line summary, generated
   * by the utility provider (local Ollama when available, else Claude — heavy
   * lifting offloads automatically). Best-effort: never blocks a save.
   */
  private async maybeIndex(content: string): Promise<{ tags: string[]; summary?: string; title?: string }> {
    if (!this.plugin.settings.autoTagOnSave) return { tags: [] };
    try {
      const { summarizeAndTag, existingVaultTags } = await import("../indexing/autoTagger");
      const res = await summarizeAndTag(this.app, this.plugin.router(), content, existingVaultTags(this.app));
      return {
        tags: res.tags,
        ...(res.summary ? { summary: res.summary } : {}),
        ...(res.title ? { title: res.title } : {}),
      };
    } catch {
      return { tags: [] };
    }
  }

  /**
   * A title derived from the *answer*, never the prompt. Used as a fallback when
   * the indexer (which produces a better title) is disabled or fails.
   */
  private fallbackTitle(): string {
    const firstAssistant = this.messages.find((m) => m.role === "assistant")?.content ?? "";
    const line = firstAssistant
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim())
      .find((l) => l.length > 0) ?? "";
    // Match the first sentence with a lookahead (lookbehind is unsupported on iOS < 16.4).
    const sentence = line.match(/^.*?[.?!](?=\s)/)?.[0] || line;
    return (sentence || "Claude chat").slice(0, 60);
  }

  /**
   * Save a reply as a durable, indexed note. If the reply contains a
   * `claude-html` artifact, it's saved as an artifact note (renders inline) —
   * not a raw fenced dump. Either way it gets auto-tags + a summary in
   * frontmatter so semantic/query search and Dataview index it correctly.
   */
  private async saveReplyAsNote(full: string): Promise<void> {
    const artifact = extractArtifact(full);
    new Notice("Indexing & saving…");

    // A plan reply carries a `## Build tasks` checklist. Save it as a canonical
    // `type: plan` note (artifact renders inline + checklist drives Build).
    if (extractTasks(full).length > 0) {
      const { tags, summary, title } = await this.maybeIndex(full);
      const planTitle = title ?? artifact?.title ?? this.fallbackTitle();
      const file = await savePlanNote(this.app, this.plugin.settings.planFolder, planTitle, full, {
        extraTags: tags,
        ...(summary !== undefined ? { summary } : {}),
      });
      await this.app.workspace.getLeaf(true).openFile(file);
      return;
    }

    if (artifact) {
      const { tags, summary } = await this.maybeIndex(`${artifact.title}\n\n${full}`);
      const file = await saveArtifactNote(this.app, this.plugin.settings.artifactFolder, artifact, {
        height: this.plugin.settings.artifactHeight,
        baseTags: this.plugin.settings.artifactBaseTags,
        extraTags: tags,
        ...(summary !== undefined ? { summary } : {}),
      });
      await this.app.workspace.getLeaf(true).openFile(file);
      return;
    }
    const { tags, summary, title } = await this.maybeIndex(full);
    const heuristic = full.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 60) ?? "Claude reply";
    await saveChatNote(this.app, this.plugin.settings.chatFolder, title ?? heuristic, full, {
      baseTags: this.plugin.settings.chatBaseTags,
      extraTags: tags,
      ...(summary !== undefined ? { summary } : {}),
    });
  }

  private actionBtn(bar: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
    const btn = bar.createEl("button", { cls: "cc-action", attr: { "aria-label": label, title: label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private insertIntoNote(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note to insert into.");
      return;
    }
    view.editor.replaceSelection(text);
    new Notice("Inserted into note");
  }

  private async saveChat(): Promise<void> {
    if (this.messages.length === 0) {
      new Notice("Nothing to save yet.");
      return;
    }
    const md = this.messages.map((m) => `**${m.role === "user" ? "You" : "Claude"}:**\n\n${m.content}`).join("\n\n---\n\n");
    new Notice("Indexing & saving…");
    const { tags, summary, title } = await this.maybeIndex(md);
    const finalTitle = title ?? this.fallbackTitle();
    await saveChatNote(this.app, this.plugin.settings.chatFolder, finalTitle, md, {
      baseTags: this.plugin.settings.chatBaseTags,
      extraTags: tags,
      ...(summary !== undefined ? { summary } : {}),
    });
    if (this.plugin.settings.memoryEnabled && this.plugin.settings.memoryIngestOnSave) {
      await this.plugin.captureConversation(this.messages); // also file this chat into memory
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
