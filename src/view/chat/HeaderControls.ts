import { Platform, setIcon, Menu, Modal, Notice, type App } from "obsidian";
import type ClaudeCompanionPlugin from "../../main";
import { renderCompanionChrome } from "../companionChrome";
import type { ChatMessage } from "../../types";
import type { Conversation } from "../../conversations/store";
import { ConversationPicker } from "../ConversationPicker";
import { modelLabel } from "../../claude/models";
import { isMobileModelChoiceActive, mobileModelChoices } from "../mobileModelChoices";
import type { ChatControls } from "../../claude/chatControls";
import type { ChatMode } from "../ModeControl";
import type { CliBackend, CliSignInProvider } from "../../cli/backends/types";
import type { ProviderRouter } from "../../providers/router";
import { contextGauge, estimateTokens, estimateTokensForChars, formatCost, formatTokens, sessionCost, type SessionUsage } from "../../usage/tokens";
import type { ChatProject } from "../../projects/model";
import { ActionModal, type ActionModalItem } from "../ActionModal";
import { QuickOptionsModal } from "../QuickOptionsModal";
import { quickNotice } from "../../notice";

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
  applyMode(mode: ChatMode): Promise<void>;
  clearChat(): void;
  cliEntries(router: ProviderRouter): { backend: CliBackend; provider: CliSignInProvider }[];
  loadConversation(conversation: Conversation): void;
  openSettings(): void;
  renderContextManager(): void;
  renderKnobs(): void;
  renderKnobsInto(parent: HTMLElement): void;
  saveChat(): Promise<void>;
  updateModeControl(): void;
  agentCapable(): boolean;
  setAgentCapable(v: boolean): void;
  agentWriteAlways(): boolean;
  controls(): ChatControls;
  inputEl(): HTMLTextAreaElement;
  messages(): ChatMessage[];
  planMode(): boolean;
  reasoningEl(): HTMLButtonElement | null;
  session(): SessionUsage;
  currentProject(): ChatProject | null;
}

/** The chat panel's header row: eyebrow/title, model chip, backend/write-grant pills, chrome-hosted actions. */
export class HeaderControls {
  modelLabelEl!: HTMLElement;
  /** The active chat project's name, next to the conversation title; empty (hidden via CSS) when there's none. */
  projectLabelEl!: HTMLElement;
  /** Desktop only: the text span nested inside the cc-model chip (dot + text + chevron). */
  modelTextEl: HTMLElement | null = null;
  backendPillEl!: HTMLElement;
  writeGrantPillEl!: HTMLElement;
  mcpStatusEl!: HTMLButtonElement;
  usageEl!: HTMLElement;
  gaugeFillEl!: HTMLElement;
  private disposeChrome: ((remove?: boolean) => void) | null = null;

  /** Detach any chrome mounted by a previous mount() call. */
  teardown(remove?: boolean): void {
    this.disposeChrome?.(remove);
    this.disposeChrome = null;
  }

  mount(root: HTMLElement, cb: HeaderControlsCallbacks): void {
    const header = root.createDiv({ cls: "cc-header" });
    const title = header.createDiv({ cls: "cc-title" });
    title.createSpan({ cls: "cc-eyebrow", text: "COMPANION FOR CLAUDE" });
    this.projectLabelEl = title.createSpan({ cls: "cc-project-label" });
    this.modelLabelEl = title.createSpan({ cls: "cc-model" });
    this.backendPillEl = title.createSpan({ cls: "cc-backend-pill", attr: { "aria-label": "Chat backend / connectivity" } });
    this.writeGrantPillEl = title.createEl("button", {
      cls: "cc-write-grant-pill",
      text: "✎ writes auto-allowed",
      attr: { "aria-label": "Agent writes are auto-allowed for this session — click to revoke" },
    });
    this.writeGrantPillEl.addEventListener("click", () => cb.onWriteGrantRevoke());
    const actions = header.createDiv({ cls: "cc-header-actions" });
    if (Platform.isMobile) {
      // Mobile: the model name is the model picker, and one ⋯ menu carries the
      // actions the desktop icon row holds, plus the session toggles from the
      // hidden controls bar (Act on vault, Plan mode, memory ingest). Truly
      // desktop-only chrome (MCP, session capture) stays omitted.
      this.modelLabelEl.addClass("cc-model-tappable");
      this.modelLabelEl.addEventListener("click", () => cb.onModelClick());
      const more = actions.createEl("button", { cls: "cc-icon-btn clickable-icon", attr: { "aria-label": "More actions" } });
      setIcon(more, "more-vertical");
      more.addEventListener("click", () => cb.onOverflow());
      // Quick options reaches mobile through that one ⋯ menu; a second control on
      // a phone-width header is the crowding this row exists to avoid.
      this.disposeChrome = renderCompanionChrome(root, "chat", "Chat", this.plugin.companionChrome(), {
        host: actions,
        compact: true,
        omitOptionsButton: true,
      });
    } else {
      // Desktop: same pattern as mobile — the model name opens the model picker,
      // and one "More" button carries the rest (Save, capture, MCP bridge) so the
      // header stays a calm 3-icon row plus quick options.
      this.modelLabelEl.addClass("cc-model-tappable");
      this.modelLabelEl.addEventListener("click", () => cb.onModelClick());
      this.mcpStatusEl = this.modelLabelEl.createEl("button", { cls: "cc-mcp-dot", attr: { "aria-label": "MCP bridge controls" } });
      this.mcpStatusEl.addEventListener("click", (evt) => {
        evt.stopPropagation();
        cb.onMcpClick(evt);
      });
      this.modelTextEl = this.modelLabelEl.createSpan({ cls: "cc-model-text" });
      setIcon(this.modelLabelEl.createSpan({ cls: "cc-model-chevron" }), "chevron-down");

      const primary = actions.createDiv({ cls: "cc-header-actions-primary" });
      this.iconButton(primary, "plus", "New chat", () => cb.onNewChat());
      this.iconButton(primary, "history", "Resume a past conversation", () => cb.onHistory());
      this.iconButton(primary, "more-horizontal", "More actions", () => cb.onOverflow());
      // Quick options joins this row rather than owning a header of its own, and
      // replaces the gear: its own sheet already offers "Open all settings".
      this.disposeChrome = renderCompanionChrome(root, "chat", "Chat", this.plugin.companionChrome(), {
        host: primary,
        compact: true,
      });
    }
  }

  /** Mount the context-window gauge + usage text into the composer's send group. */
  mountUsage(parent: HTMLElement): void {
    const usageRow = parent.createDiv({ cls: "cc-usage" });
    const gauge = usageRow.createDiv({ cls: "cc-gauge", attr: { "aria-label": "Estimated context window used" } });
    this.gaugeFillEl = gauge.createDiv({ cls: "cc-gauge-fill" });
    this.usageEl = usageRow.createDiv({ cls: "cc-usage-text" });
  }

  private iconButton(parent: HTMLElement, icon: string, tip: string, onClick: () => void): void {
    const btn = parent.createEl("button", { cls: "cc-icon-btn clickable-icon", attr: { "aria-label": tip } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
  }

  constructor(private app: App, private plugin: ClaudeCompanionPlugin, private deps: HeaderControlsDeps) {}

  private get agentCapable(): boolean { return this.deps.agentCapable(); }
  private set agentCapable(v: boolean) { this.deps.setAgentCapable(v); }
  private get agentWriteAlways(): boolean { return this.deps.agentWriteAlways(); }
  private get controls(): ChatControls { return this.deps.controls(); }
  private get inputEl(): HTMLTextAreaElement { return this.deps.inputEl(); }
  private get messages(): ChatMessage[] { return this.deps.messages(); }
  private get planMode(): boolean { return this.deps.planMode(); }
  private get reasoningEl(): HTMLButtonElement | null { return this.deps.reasoningEl(); }
  private get session(): SessionUsage { return this.deps.session(); }

  /**
   * Recompute the context gauge (estimated input + reserved output vs the
   * model's window) and render the running session totals. Called on input,
   * after each response, and when the model changes.
   */
  updateUsageBar(): void {
    const { model: resolvedModel } = this.plugin.router().chatProvider();
    const caps = this.plugin.router().chatCapabilities();
    const local = caps.local;
    const model = local ? resolvedModel : this.controls?.model ?? this.plugin.settings.model;
    const reserved = this.controls?.maxTokens ?? this.plugin.settings.maxTokens;

    // Estimate input tokens: system + conversation so far + the draft + a
    // rough allowance for the vault context that will be attached.
    const convo = this.messages.map((m) => m.content).join("\n");
    const draft = this.inputEl?.value ?? "";
    const ctxAllowance = this.deps.anyContextEnabled() ? this.plugin.settings.contextCharBudget : 0;
    const project = this.deps.currentProject();
    const estIn = estimateTokens(this.plugin.composeSystemPrompt({ ...(project ? { project } : {}) })) + estimateTokens(convo) + estimateTokens(draft) + estimateTokensForChars(ctxAllowance);

    const g = contextGauge(estIn, model, reserved);
    this.gaugeFillEl.setCssStyles({ width: `${Math.round(g.fraction * 100)}%` });
    this.gaugeFillEl.toggleClass("is-warn", g.fraction >= 0.75 && g.fraction < 0.92);
    this.gaugeFillEl.toggleClass("is-danger", g.fraction >= 0.92);

    const parts: string[] = [];
    if (local) {
      parts.push(`~${formatTokens(estIn)} ctx · local (no metered cost)`);
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
    const { model: resolvedModel } = this.plugin.router().chatProvider();
    const caps = this.plugin.router().chatCapabilities();
    const chosen = modelLabel(this.controls?.model ?? this.plugin.settings.model);
    const label = caps.local ? `${modelLabel(resolvedModel)} · local` : chosen;
    // Desktop nests the dot + chevron inside cc-model, so the name text goes into
    // its own child span; mobile has no such child and keeps setting cc-model directly.
    (this.modelTextEl ?? this.modelLabelEl).setText(label);
    if (this.usageEl) this.updateUsageBar();
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
    if (backend === "claude-cli" || backend === "codex-cli" || backend === "opencode-cli") {
      const entry = this.deps.cliEntries(router).find((e) => e.backend.id === backend);
      const label = entry?.backend.label ?? "CLI";
      const ok = entry?.provider.hasCredentials() ?? false;
      el.setText(ok ? `● ${label}` : router.anthropic.hasCredentials() ? `● ${label} offline · API key` : `● ${label} not signed in`);
      el.toggleClass("is-ok", ok);
      el.toggleClass("is-warn", !ok);
      return;
    }
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
      { title: "Source inbox", icon: "inbox", run: () => void this.plugin.activateInboxView() },
      { title: "Related notes", icon: "link", run: () => void this.plugin.activateRelatedView() },
      { title: "Research Desk", icon: "flask-conical", run: () => void this.plugin.activateResearchDesk() },
      { title: "New chat", icon: "plus", run: () => this.deps.clearChat() },
      { title: "New chat tab", icon: "plus", run: () => void this.plugin.openNewChatTab() },
      { title: "History", icon: "history", run: () => this.openHistory() },
      { title: "Save chat to vault", icon: "save", run: () => void this.deps.saveChat() },
    ];
    if (!Platform.isMobile) {
      if (this.plugin.settings.memoryEnabled) {
        items.push({ title: "Capture a Claude Code session…", icon: "import", run: () => void this.plugin.openSessionPicker() });
      }
      items.push({ title: "MCP bridge…", icon: "plug-zap", run: () => this.openMcpMenu(this.mcpStatusEl) });
    }
    items.push(
      { title: "Model controls…", icon: "sliders-horizontal", run: () => this.openTuneModal() },
      { title: "Options…", icon: "settings-2", run: () => new QuickOptionsModal(this.app, "chat", this.plugin.companionChrome()).open() },
    );
    // Session toggles that live in the hidden desktop controls bar — without
    // these, phone users can't reach agent writes, Plan Mode, or memory ingest.
    const canAct = this.plugin.settings.agentModeEnabled && this.plugin.router().chatCapabilities().agentActions;
    if (canAct) {
      items.push(
        { title: "Act on vault", icon: "pencil-line", checked: this.plugin.settings.agentAllowWrites, separatorBefore: true, run: () => void this.deps.applyMode(this.plugin.settings.agentAllowWrites ? "ask" : "act") },
        { title: "Plan mode", icon: "list-todo", checked: this.planMode, run: () => void this.deps.applyMode(this.planMode ? (this.plugin.settings.agentAllowWrites ? "act" : "ask") : "plan") },
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
    if (cloudDispatch) items.push({ title: "Send to cloud session", icon: "cloud", separatorBefore: true, run: () => void this.plugin.dispatchCloudSession() });
    if (cloudReplies) items.push({ title: "Pull cloud replies", icon: "cloud-download", separatorBefore: !cloudDispatch, run: () => void this.plugin.pullCloudReplies() });
    items.push({ title: "Settings", icon: "settings", separatorBefore: true, run: () => this.deps.openSettings() });
    new ActionModal(this.app, "Companion actions", items).open();
  }

  /** Model picker opened by tapping the model name in the header. */
  openModelMenu(): void {
    const resolved = this.plugin.router().chatProvider();
    const activeModel = resolved.provider.id === "anthropic" ? this.controls.model : resolved.model;
    const items = mobileModelChoices({
      // Avoid a network probe on tap: the configured local model is the one
      // mobile users need to retain/switch back to. Discovery remains in settings.
      ollamaModels: [],
      configuredOllamaModel: this.plugin.settings.ollamaModel,
      openaiCompatHost: this.plugin.settings.openaiCompatHost,
      openaiCompatModel: this.plugin.settings.openaiCompatModel,
    }).map((choice): ActionModalItem => ({
      title: choice.label,
      checked: isMobileModelChoiceActive(choice, resolved.provider.id, activeModel),
      run: () => void this.onModelSelect(choice.value),
    }));
    new ActionModal(this.app, "Choose model", items).open();
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
    if (value.startsWith("ollama:")) {
      this.plugin.settings.ollamaModel = value.slice("ollama:".length);
      this.plugin.settings.chatBackend = "local";
    } else if (value.startsWith("custom:")) {
      // The picker now lists every endpoint model, so the choice has to land in
      // settings — the router reads openaiCompatModel, not the select value.
      this.plugin.settings.openaiCompatModel = value.slice("custom:".length);
      this.plugin.settings.chatBackend = "custom";
    } else {
      this.controls.model = value;
      if (this.plugin.settings.chatBackend === "local" || this.plugin.settings.chatBackend === "custom") this.plugin.settings.chatBackend = "auto";
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
      this.agentCapable = this.plugin.settings.agentModeEnabled && (await router.chatToolCapable());
      this.deps.updateModeControl();
      const el = this.reasoningEl;
      if (!el) return;
      const reasoning = await router.chatReasoningActive(this.controls.thinking);
      const { provider, model } = router.chatProvider();
      el.toggleClass("is-active", reasoning);
      el.setAttr(
        "aria-label",
        reasoning
          ? "Reasoning on — this model thinks before answering"
          : provider.id === "anthropic"
            ? "Reasoning off — enable thinking in model controls (the tune button)"
            : `Reasoning off — ${model} doesn't report a thinking capability`,
      );
      el.setAttr("title", el.getAttr("aria-label") ?? "");
    })();
  }

  openHistory(): void {
    const conversations = this.plugin.listConversations();
    if (conversations.length === 0) {
      new Notice("No saved conversations yet.");
      return;
    }
    new ConversationPicker(
      this.app,
      conversations,
      (chosen) => {
        void this.plugin.setActiveConversation(chosen.id).then((c) => {
          if (c) this.deps.loadConversation(c);
        });
      },
      (doomed) => {
        void (async () => {
          if (this.plugin.getActiveConversation()?.id === doomed.id) {
            await this.plugin.deleteActiveConversation(); // resets the view + notices
          } else {
            await this.plugin.deleteConversation(doomed.id);
            quickNotice(`Deleted “${doomed.title}”.`);
          }
          this.openHistory(); // reopen with the refreshed list
        })();
      },
    ).open();
  }
}
