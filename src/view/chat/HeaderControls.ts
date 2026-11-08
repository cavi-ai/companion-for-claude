import { Platform, setIcon, Menu, Modal, type App } from "obsidian";
import type { HeaderHost } from "./hosts";
import { renderCompanionChrome } from "../companionChrome";
import type { ChatMessage } from "../../types";
import type { Conversation } from "../../conversations/store";
import { SessionDropdown } from "./SessionDropdown";
import { CLAUDE_MODELS, modelLabel } from "../../claude/models";
import { DEVICE_MODELS, DEVICE_MAX_INPUT_TOKENS, DEVICE_MAX_OUTPUT_TOKENS } from "../../device/models";
import { MODEL_BACKEND_LABELS, ModelCatalogSource } from "./modelCatalog";
import { ModelPickerModal } from "../ModelPickerModal";
import { chatBackendForRuntime } from "../../providers/runtimeBackend";
import type { ChatControls } from "../../claude/chatControls";
import type { ChatSession } from "./chatSession";
import { contextGauge, estimateTokens, estimateTokensForChars, formatCost, formatTokens, sessionCost, type SessionUsage } from "../../usage/tokens";
import { ActionModal, type ActionModalItem } from "../ActionModal";
import { QuickOptionsModal } from "../QuickOptionsModal";
import { quickNotice, CompanionNotice as Notice } from "../../notice";

const HEADER_BACKEND_LABELS = { ...MODEL_BACKEND_LABELS, claude: "API", device: "On-device" };

export interface HeaderControlsCallbacks {
  onModelClick: () => void;
  onMcpClick: (evt: MouseEvent) => void;
  onWriteGrantRevoke: () => void;
  onNewChat: () => void;
  onHistory: () => void;
  onOverflow: () => void;
}

export interface HeaderControlsDeps {
  anyContextEnabled(): boolean;
  conversationId(): string | null;
  refreshTabTitle(): void;
  clearChat(): void;
  loadConversation(conversation: Conversation): void;
  openSettings(): void;
  renderContextManager(): void;
  renderKnobs(): void;
  renderKnobsInto(parent: HTMLElement): void;
  distillChat(): Promise<void>;
  /** The composer's unsent text, for the context gauge. */
  draft(): string;
  /** Show whether the chat model reasons before answering, with the reason as its label. */
  showReasoning(active: boolean, label: string): void;
}

/** The chat panel's header row: eyebrow/title, model chip, backend/write-grant pills, chrome-hosted actions. */
export class HeaderControls {
  modelLabelEl!: HTMLElement;
  sessionTitleEl!: HTMLElement;
  private modelPicker: ModelPickerModal | null = null;
  /** The active chat project's name, next to the conversation title; empty (hidden via CSS) when there's none. */
  projectLabelEl!: HTMLElement;
  /** The model name stays separate from the backend prefix on both platforms. */
  modelTextEl: HTMLElement | null = null;
  backendPillEl!: HTMLElement;
  writeGrantPillEl!: HTMLElement;
  mcpStatusEl!: HTMLButtonElement;
  usageEl!: HTMLElement;
  gaugeFillEl!: HTMLElement;
  private disposeChrome: ((remove?: boolean) => void) | null = null;
  private headerEl: HTMLElement | null = null;
  private historyBtnEl: HTMLElement | null = null;
  private sessionDropdown: SessionDropdown | null = null;
  private sessionListKey = "";

  /** Detach any chrome mounted by a previous mount() call. */
  teardown(remove?: boolean): void {
    this.modelPicker?.close();
    this.modelPicker = null;
    this.sessionDropdown?.close();
    this.sessionDropdown = null;
    this.disposeChrome?.(remove);
    this.disposeChrome = null;
  }

  mount(root: HTMLElement, cb: HeaderControlsCallbacks): void {
    const header = root.createDiv({ cls: "cc-header" });
    this.headerEl = header;
    const session = header.createDiv({ cls: "cc-header-session" });
    this.sessionTitleEl = session.createSpan({ cls: "cc-session-title", text: "New chat" });
    this.projectLabelEl = session.createSpan({ cls: "cc-project-label" });
    const actions = session.createDiv({ cls: "cc-header-actions" });
    const primary = actions.createDiv({ cls: "cc-header-actions-primary" });
    const history = primary.createEl("button", { cls: "cc-sessions-btn", attr: { type: "button", "aria-label": "Sessions" } });
    setIcon(history.createSpan({ cls: "cc-sessions-icon", attr: { "aria-hidden": "true" } }), "history");
    history.createSpan({ cls: "cc-sessions-label", text: "Sessions" });
    history.addEventListener("click", () => cb.onHistory());
    this.historyBtnEl = history;
    this.iconButton(primary, "plus", "New chat", () => cb.onNewChat());
    this.iconButton(primary, Platform.isMobile ? "more-vertical" : "more-horizontal", "More actions", () => cb.onOverflow());

    const routing = header.createDiv({ cls: "cc-header-routing" });
    this.modelLabelEl = routing.createEl("button", { cls: "cc-model", attr: { type: "button", "aria-label": "Choose model and backend", "aria-haspopup": "dialog" } });
    this.modelLabelEl.addEventListener("click", () => cb.onModelClick());
    this.backendPillEl = this.modelLabelEl.createSpan({ cls: "cc-model-backend" });
    this.modelTextEl = this.modelLabelEl.createSpan({ cls: "cc-model-text" });
    setIcon(this.modelLabelEl.createSpan({ cls: "cc-model-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
    const activity = routing.createDiv({ cls: "cc-header-activity" });
    this.disposeChrome = renderCompanionChrome(root, "chat", "Chat", this.plugin.shell().companionChrome(), { host: activity, compact: true });
    activity.querySelector(".cc-companion-quick-options")?.addClass("cc-header-secondary");
    this.writeGrantPillEl = routing.createEl("button", {
      cls: "cc-write-grant-pill", text: "✎",
      attr: { type: "button", "aria-label": "Revoke automatic write permission for this session" },
    });
    this.writeGrantPillEl.addEventListener("click", () => cb.onWriteGrantRevoke());
    if (!Platform.isMobile) {
      this.mcpStatusEl = routing.createEl("button", { cls: "cc-mcp-dot cc-header-secondary", attr: { type: "button", "aria-label": "MCP bridge controls" } });
      setIcon(this.mcpStatusEl, "plug-zap");
      this.mcpStatusEl.addEventListener("click", evt => cb.onMcpClick(evt));
    }
    this.refreshSessionTitle();
  }

  refreshSessionTitle(): void {
    if (!this.sessionTitleEl && !this.sessionDropdown) return;
    const id = this.deps.conversationId?.() ?? null;
    const conversations = this.plugin.conversations().list();
    const conversation = id ? conversations.find(entry => entry.id === id) : undefined;
    this.sessionTitleEl?.setText(conversation?.title ?? "New chat");
    const key = JSON.stringify([id, conversations.map(entry => [entry.id, entry.title, entry.archivedAt, entry.updatedAt, entry.messages.length])]);
    if (this.sessionListKey !== key) { this.sessionListKey = key; this.sessionDropdown?.refresh(); }
  }

  /** Mount the context-window gauge + usage text into the composer's send group. */
  mountUsage(parent: HTMLElement): void {
    const usageRow = parent.createDiv({ cls: "cc-usage" });
    const gauge = usageRow.createDiv({ cls: "cc-gauge", attr: { "aria-label": "Estimated context window used" } });
    this.gaugeFillEl = gauge.createDiv({ cls: "cc-gauge-fill" });
    this.usageEl = usageRow.createDiv({ cls: "cc-usage-text" });
  }

  private iconButton(parent: HTMLElement, icon: string, tip: string, onClick: () => void): HTMLElement {
    const btn = parent.createEl("button", { cls: "cc-icon-btn clickable-icon", attr: { "aria-label": tip } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  constructor(private app: App, private plugin: HeaderHost, private chat: ChatSession, private deps: HeaderControlsDeps) {}

  private get agentWriteAlways(): boolean { return this.chat.writeGrant; }
  private get controls(): ChatControls { return this.chat.controls; }
  private get messages(): ChatMessage[] { return this.chat.messages; }
  private get session(): SessionUsage { return this.chat.turn.session; }

  /**
   * Recompute the context gauge (estimated input + reserved output vs the
   * model's window) and render the running session totals. Called on input,
   * after each response, and when the model changes.
   */
  updateUsageBar(): void {
    const { model: resolvedModel, provider } = this.plugin.router().chatProvider();
    const caps = this.plugin.router().chatCapabilities();
    const local = caps.local;
    const model = local ? resolvedModel : this.controls?.model ?? this.plugin.settings.model;
    const device = provider.id === "device";
    const configuredOutput = this.controls?.maxTokens ?? this.plugin.settings.maxTokens;
    const reserved = device ? Math.min(configuredOutput, DEVICE_MAX_OUTPUT_TOKENS) : configuredOutput;

    // Estimate input tokens: system + conversation so far + the draft + a
    // rough allowance for the vault context that will be attached.
    const convo = this.messages.map((m) => m.content).join("\n");
    const draft = this.deps.draft();
    const ctxAllowance = this.deps.anyContextEnabled() ? this.plugin.settings.contextCharBudget : 0;
    const project = this.chat.project;
    const estIn = estimateTokens(this.plugin.composeSystemPrompt({ ...(project ? { project } : {}), compact: device })) + estimateTokens(convo) + estimateTokens(draft) + estimateTokensForChars(ctxAllowance);

    const g = contextGauge(estIn, model, reserved, device ? DEVICE_MAX_INPUT_TOKENS + DEVICE_MAX_OUTPUT_TOKENS : undefined);
    this.gaugeFillEl.setCssStyles({ width: `${Math.round(g.fraction * 100)}%` });
    this.gaugeFillEl.toggleClass("is-warn", g.fraction >= 0.75 && g.fraction < 0.92);
    this.gaugeFillEl.toggleClass("is-danger", g.fraction >= 0.92);

    const parts: string[] = [];
    if (local) {
      parts.push(device ? `~${formatTokens(estIn)} / ${formatTokens(DEVICE_MAX_INPUT_TOKENS)} input · on-device` : `~${formatTokens(estIn)} ctx · local (no metered cost)`);
      // Local turns report token counts too (Ollama), so show running totals
      // without a cost — the same shape as the OAuth/subscription branch.
      if (this.session.requests > 0) {
        parts.push(`session ${formatTokens(this.session.inputTokens)}↑ ${formatTokens(this.session.outputTokens)}↓`);
      }
    } else {
      parts.push(`~${formatTokens(estIn)} / ${formatTokens(g.window)} ctx`);
      // OAuth subscription tokens don't bill per-token, so show token totals
      // without a dollar estimate; API-key usage shows the estimated cost.
      const oauth = !caps.metered;
      if (this.session.requests > 0) {
        const totals = `session ${formatTokens(this.session.inputTokens)}↑ ${formatTokens(this.session.outputTokens)}↓`;
        parts.push(oauth ? `${totals} · subscription` : `${totals} ≈ ${formatCost(sessionCost(this.session, model))}`);
      }
    }
    this.usageEl.setText(parts.join("  ·  "));
  }

  /** Text only, next to the title; `null` hides it (empty text, CSS-collapsed). */
  setProjectLabel(name: string | null): void {
    this.projectLabelEl?.setText(name ?? "");
  }

  refreshModelLabel(): void {
    if (!this.modelLabelEl) return;
    const backend = chatBackendForRuntime(this.plugin.settings.chatBackend, Platform.isMobile);
    const router = this.plugin.router();
    const resolved = router.chatProvider();
    const servingBackend = ({ anthropic: "claude", "claude-cli": "claude-cli", "codex-cli": "codex-cli", "opencode-cli": "opencode-cli", ollama: "local", "openai-compat": "custom", device: "device" } as const)[resolved.provider.id];
    const model = servingBackend === "claude" ? this.controls?.model ?? resolved.model : resolved.model;
    const label = servingBackend === "codex-cli" ? router.codexCli.modelLabel(model)
      : servingBackend === "opencode-cli" ? router.opencodeCli.modelLabel(model)
      : servingBackend === "device" ? DEVICE_MODELS.find(entry => entry.id === model)?.name ?? model
      : modelLabel(model);
    const serving = HEADER_BACKEND_LABELS[servingBackend];
    const prefix = backend === "auto" ? `Auto · ${serving}`
      : backend === servingBackend ? HEADER_BACKEND_LABELS[backend]
      : `${HEADER_BACKEND_LABELS[backend]} → ${serving}`;
    const accessiblePrefix = backend === "auto" ? `Auto · ${MODEL_BACKEND_LABELS[servingBackend]}`
      : backend === servingBackend ? MODEL_BACKEND_LABELS[backend]
      : `${MODEL_BACKEND_LABELS[backend]} → ${MODEL_BACKEND_LABELS[servingBackend]}`;
    this.backendPillEl?.setText(prefix);
    (this.modelTextEl ?? this.modelLabelEl)?.setText(label);
    this.modelLabelEl?.setAttr("aria-label", `Choose model and backend: ${accessiblePrefix} · ${label}`);
    this.refreshSessionTitle();
    if (this.usageEl) this.updateUsageBar();
  }

  /** The selected route is part of the model control, without a second readiness row. */
  async refreshBackendPill(): Promise<void> { if (this.modelLabelEl) this.refreshModelLabel(); }

  async refreshContextStatus(): Promise<void> {
    // Refresh active-note detail as navigation changes, and the MCP header icon.
    this.deps.renderContextManager();
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

  /** `anchor` is a real MouseEvent from the header dot, or the dot element itself when opened from the overflow menu (which has already closed and lost the click event). */
  openMcpMenu(anchor: MouseEvent | HTMLElement): void {
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
        .onClick(() => this.deps.openSettings());
    });
    if (anchor instanceof HTMLElement) {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    } else {
      menu.showAtMouseEvent(anchor);
    }
  }

  /** Mobile: the tune knobs (thinking / effort / temp / max) in a modal. */
  openTuneModal(): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Model controls");
    modal.contentEl.addClass("cc-knobs", "cc-knobs-modal");
    this.deps.renderKnobsInto(modal.contentEl);
    modal.open();
  }

  /** The single ⋯ menu: on mobile it replaces the header icon row entirely; on desktop it carries the actions the 3-icon row + model chip don't. */
  openOverflowMenu(): void {
    const items: ActionModalItem[] = [
      { title: "Source inbox", icon: "inbox", run: () => void this.plugin.views().activateInboxView() },
      { title: "Related notes", icon: "link", run: () => void this.plugin.views().activateRelatedView() },
      { title: "Research Desk", icon: "flask-conical", run: () => void this.plugin.research().activateResearchDesk() },
      { title: "New chat", icon: "plus", run: () => this.deps.clearChat() },
      { title: "New chat tab", icon: "plus", run: () => void this.plugin.views().openNewChatTab() },
      { title: "History", icon: "history", run: () => this.openHistory() },
      { title: "Distill this chat", icon: "sparkles", run: () => void this.deps.distillChat() },
    ];
    if (!Platform.isMobile) {
      if (this.plugin.settings.memoryEnabled) {
        items.push({ title: "Capture a Claude Code session…", icon: "import", run: () => void this.plugin.memory().openSessionPicker() });
      }
      items.push({ title: "MCP bridge…", icon: "plug-zap", run: () => this.openMcpMenu(this.mcpStatusEl) });
    }
    items.push(
      { title: "Model controls…", icon: "sliders-horizontal", run: () => this.openTuneModal() },
      { title: "Quick options…", icon: "settings-2", run: () => new QuickOptionsModal(this.app, "chat", this.plugin.shell().companionChrome()).open() },
    );
    // Session toggles from the desktop controls bar. Phones set Ask / Plan / Act
    // from the composer toolbar, so the mode items are desktop-only here.
    const canAct = !Platform.isMobile && this.plugin.settings.agentModeEnabled && this.plugin.router().chatCapabilities().agentActions;
    if (canAct) {
      items.push(
        { title: "Act on vault", icon: "pencil-line", checked: this.chat.mode.writes, separatorBefore: true, run: () => void this.chat.mode.toggleWrites() },
        { title: "Plan mode", icon: "list-todo", checked: this.chat.mode.mode === "plan", run: () => void this.chat.mode.togglePlan() },
      );
    }
    if (this.plugin.settings.memoryEnabled) {
      items.push({
        title: "File chats into session memory", icon: "archive", checked: this.plugin.settings.memoryIngestOnSave,
        separatorBefore: !canAct,
        run: () => {
          this.plugin.settings.memoryIngestOnSave = !this.plugin.settings.memoryIngestOnSave;
          void this.plugin.saveSettings();
        },
      });
    }
    // Cloud actions only when actually configured — a menu item that just
    // bounces a "feature is off" notice is noise.
    const cloudDispatch = this.plugin.settings.cloudDispatchEnabled;
    const cloudReplies = this.plugin.settings.cloudReplyRepo.trim().length > 0;
    if (cloudDispatch) items.push({ title: "Send to cloud session", icon: "cloud", separatorBefore: true, run: () => void this.plugin.publishing().dispatchCloudSession() });
    if (cloudReplies) items.push({ title: "Pull cloud replies", icon: "cloud-download", separatorBefore: !cloudDispatch, run: () => void this.plugin.publishing().pullCloudReplies() });
    items.push({ title: "Settings", icon: "settings", separatorBefore: true, run: () => this.deps.openSettings() });
    new ActionModal(this.app, "Companion actions", items).open();
  }

  /** Model picker opened by tapping the model name in the header. */
  openModelMenu(): void {
    this.modelPicker?.close();
    const source = new ModelCatalogSource(this.plugin, () => this.controls.model, Platform.isMobile);
    this.modelPicker = new ModelPickerModal(this.app, source, value => void this.onModelSelect(value), () => this.deps.openSettings());
    this.modelPicker.open();
  }

  /** Show the session-grant pill only while the grant is live. */
  updateWriteGrantPill(): void {
    this.writeGrantPillEl?.toggleClass("is-on", this.agentWriteAlways);
  }

  /**
   * Apply a model-switcher choice. Picking a `ollama:<model>` entry routes the
   * chat to that local model (backend → local); picking a Claude model routes
   * back to Claude (backend → auto, so it still falls back to local when needed).
   */
  async onModelSelect(value: string): Promise<void> {
    const route = /^(auto|claude|claude-cli):/.exec(value);
    if (route && (!Platform.isMobile || route[1] !== "claude-cli")) {
      this.plugin.settings.chatBackend = route[1] as "auto" | "claude" | "claude-cli";
      this.controls.model = value.slice(route[0].length);
      if (CLAUDE_MODELS.some(model => model.id === this.controls.model)) this.plugin.settings.model = this.controls.model;
      else { this.plugin.settings.model = "custom"; this.plugin.settings.customModel = this.controls.model; }
    } else if (!Platform.isMobile && value.startsWith("codex-cli:")) {
      this.plugin.settings.codexModel = value.slice("codex-cli:".length);
      this.plugin.settings.chatBackend = "codex-cli";
    } else if (!Platform.isMobile && value.startsWith("opencode-cli:")) {
      this.plugin.settings.opencodeModel = value.slice("opencode-cli:".length);
      this.plugin.settings.chatBackend = "opencode-cli";
    } else if (value.startsWith("device:")) {
      const model = DEVICE_MODELS.find((m) => m.id === value.slice("device:".length));
      if (!model) return;
      this.plugin.settings.deviceChatModel = model.id;
      this.plugin.settings.chatBackend = "device";
    } else if (value.startsWith("ollama:")) {
      this.plugin.settings.ollamaModel = value.slice("ollama:".length);
      this.plugin.settings.chatBackend = "local";
    } else if (value.startsWith("custom:")) {
      // The picker now lists every endpoint model, so the choice has to land in
      // settings — the router reads openaiCompatModel, not the select value.
      this.plugin.settings.openaiCompatModel = value.slice("custom:".length);
      this.plugin.settings.chatBackend = "custom";
    } else {
      this.controls.model = value;
      if (this.plugin.settings.chatBackend === "local" || this.plugin.settings.chatBackend === "custom" || this.plugin.settings.chatBackend === "device" || this.plugin.settings.chatBackend === "codex-cli" || this.plugin.settings.chatBackend === "opencode-cli") this.plugin.settings.chatBackend = "auto";
    }
    await this.plugin.saveSettings();
    this.deps.renderKnobs(); // capabilities/provider changed → rebuild dependent knobs
    this.refreshModelLabel();
    this.refreshCapabilityIndicators(); // provider changed → gates + reasoning
    this.updateUsageBar();
    void this.refreshBackendPill();
  }

  /** Re-derive agent capability + reasoning state for the controls row (async, backend-aware). */
  refreshCapabilityIndicators(): void {
    void (async () => {
      const router = this.plugin.router();
      this.chat.mode.setCapable(this.plugin.settings.agentModeEnabled && (await router.chatToolCapable()));
      const reasoning = await router.chatReasoningActive(this.controls.thinking);
      const { provider, model } = router.chatProvider();
      this.deps.showReasoning(
        reasoning,
        reasoning
          ? "Reasoning on — this model thinks before answering"
          : provider.id === "anthropic"
            ? "Reasoning off — enable thinking in model controls (the tune button)"
            : `Reasoning off — ${model} doesn't report a thinking capability`,
      );
    })();
  }

  openHistory(): void {
    if (this.sessionDropdown?.isOpen) {
      this.sessionDropdown.close();
      return;
    }
    if (this.plugin.conversations().list().length === 0) {
      new Notice("No saved conversations yet.");
      return;
    }
    const anchor = this.historyBtnEl ?? this.headerEl;
    if (!anchor) return;
    this.sessionDropdown = new SessionDropdown({
      app: this.app,
      anchor,
      conversations: () => this.plugin.conversations().list(),
      activeId: () => this.deps.conversationId(),
      actions: {
        resume: async (chosen) => {
          const conversation = await this.plugin.conversations().setActive(chosen.id);
          if (conversation) this.deps.loadConversation(conversation);
        },
        rename: async (conversation, title) => {
          await this.plugin.conversations().rename(conversation.id, title);
          this.refreshSessionTitle();
          this.deps.refreshTabTitle();
        },
        fork: (conversation) => this.plugin.sessionActions().fork(conversation.id),
        forkFromSummary: (conversation) => this.plugin.sessionActions().forkFromSummary(conversation.id),
        distill: async (conversation) => { await this.plugin.sessionActions().distill(conversation.id); },
        archive: (conversation) => this.plugin.sessionActions().archive(conversation.id),
        unarchive: (conversation) => this.plugin.conversations().unarchive(conversation.id),
        remove: async (doomed) => {
          await this.plugin.conversations().delete(doomed.id);
          if (this.deps.conversationId() === doomed.id) this.deps.clearChat();
          this.refreshSessionTitle();
          this.deps.refreshTabTitle();
          quickNotice(`Deleted “${doomed.title}”.`);
        },
      },
      onClose: () => { this.sessionDropdown = null; },
    });
    this.sessionDropdown.open();
  }
}
