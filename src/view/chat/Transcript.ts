import { type App, MarkdownView, Notice, setIcon } from "obsidian";
import type ClaudeCompanionPlugin from "../../main";
import type { ChatMessage, ToolTraceEntry } from "../../types";
import type { AgentTurnResult } from "../../agent/loop";
import type { ChatTurnService, TurnEvent } from "../../chat/turnService";
import type { ToolResultBlock, ToolUseBlock } from "../../providers/types";
import type { Conversation } from "../../conversations/store";
import type { ChatControls } from "../../claude/chatControls";
import { hasIncompleteHtmlArtifactFence } from "../streamRender";
import { TurnRenderer, type TurnRendererHost } from "../turnRenderer";
import { extractArtifact, saveArtifactNote, saveChatNote, savePlanNote } from "../../artifacts/artifactStore";
import { extractTasks } from "../../build/spec";
import { errorHint, type ErrorHintProvider } from "../../providers/errorHints";
import { chipLabel } from "../toolChipLabel";
import { addUsage, type SessionUsage } from "../../usage/tokens";
import { mergeUsage, type TokenUsage } from "../../claude/sse";
import type { CompanionWorkspaceCard } from "../companionWorkspace";
import { quickNotice } from "../../notice";

/** Truncate a tool result for the expandable chip body. */
function previewText(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** The mutable slice of turn/session state shared between ChatView and Transcript. */
export interface TurnState {
  lastBuffer: string;
  turnUsage: TokenUsage | null;
  abort: AbortController | null;
  currentTurn: { conversationId: string; turnId: string } | null;
  session: SessionUsage;
  turnRenderUnsubscribe: (() => void) | null;
  unregisterCurrentTurn: (() => void) | null;
}

export interface TranscriptDeps {
  autosizeInput(): void;
  onSend(): Promise<void>;
  prepareWorkspaceQuestion(workspace: Pick<CompanionWorkspaceCard, "kind" | "title" | "contextPath">): void;
  regenerate(opts?: { maxTokens?: number }): Promise<void>;
  renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void>;
  renderSetupCard(parent: HTMLElement): void;
  renderStreamingArtifactInto(el: HTMLElement, buffer: string): void;
  resumeInterruptedTurn(conversation: Conversation): Promise<void>;
  restoreMediaAfterFailure(): void;
  setSending(sending: boolean): void;
  setupRequired(): boolean;
  submitPrompt(text: string, display?: string): Promise<void>;
  updateUsageBar(): void;
  controls(): ChatControls;
  inputEl(): HTMLTextAreaElement;
  lastUserText(): string;
  messages(): ChatMessage[];
  streaming(): boolean;
}

/** The message list: stored/live bubbles, turn rendering, tool chips, reply actions, empty-state and setup-card hosting. */
export class Transcript {
  messagesEl!: HTMLElement;
  /** Rotating "thinking" status word timer + per-turn start offset. */
  private thinkingTimer: number | null = null;
  private claudianSeq = 0;

  constructor(private app: App, private plugin: ClaudeCompanionPlugin, private turn: TurnState, private deps: TranscriptDeps) {}

  private get controls(): ChatControls { return this.deps.controls(); }
  private get inputEl(): HTMLTextAreaElement { return this.deps.inputEl(); }
  private get lastUserText(): string { return this.deps.lastUserText(); }
  private get messages(): ChatMessage[] { return this.deps.messages(); }
  private get streaming(): boolean { return this.deps.streaming(); }

  /** Render one persisted message, including assistant action buttons. */
  renderStoredMessage(m: ChatMessage): void {
    // A user turn with a `display` is a slash/workflow invocation — show it as a
    // command chip on replay too, matching the live render.
    if (m.role === "user" && m.display !== undefined) {
      const chipBubble = this.messagesEl.createDiv({ cls: "cc-msg cc-user cc-command" });
      this.renderCommandChip(chipBubble, m.display);
      return;
    }
    const bubble = this.messagesEl.createDiv({ cls: `cc-msg cc-${m.role}` });
    bubble.createDiv({ cls: "cc-role", text: m.role === "user" ? "You" : "Claude" });
    if (m.role === "assistant") this.addSparkMark(bubble);
    const body = bubble.createDiv({ cls: "cc-body" });
    if (m.role === "assistant" && m.toolTrace && m.toolTrace.length > 0) this.renderTraceChips(bubble, body, m.toolTrace);
    const rendered = m.display ?? m.content;
    void this.deps.renderMarkdownInto(body, rendered).catch(() => {
      // A broken Markdown extension must not make persisted conversation text
      // disappear or reject the fire-and-forget conversation replay.
      body.setText(rendered);
    });
    if (m.role === "assistant" && m.content.trim().length > 0) this.addAssistantActions(bubble, m.content);
  }

  renderEmptyState(): void {
    if (this.messages.length > 0) return;
    this.messagesEl.empty();
    const empty = this.messagesEl.createDiv({ cls: "cc-empty" });
    setIcon(empty.createDiv({ cls: "cc-empty-icon" }), "sparkles");
    empty.createDiv({ cls: "cc-empty-title", text: "Claude, in your vault." });
    empty.createDiv({
      cls: "cc-empty-sub",
      text: "Stay in the thread across notes, research, thinking, and finished work.",
    });
    if (this.deps.setupRequired()) {
      // Without a credential every example below would just error — show the
      // connect card instead and stop.
      this.deps.renderSetupCard(empty);
      return;
    }
    const workspaceMount = empty.createDiv({ cls: "cc-context-workspace-mount", attr: { "aria-live": "polite" } });
    void this.renderContextualWorkspace(workspaceMount);
    empty.createDiv({ cls: "cc-empty-section-label", text: "START SOMETHING ELSE" });
    const examples: { label: string; prompt: string; needsActiveNote?: boolean }[] = [
      { label: "📋 Summarize my active note", prompt: "Summarize my active note as concise bullet points with the key takeaways first.", needsActiveNote: true },
      { label: "📊 Turn this into a dashboard", prompt: "Turn my current note into a single beautiful, self-contained interactive dashboard artifact using the design system.", needsActiveNote: true },
      { label: "🗺️ Plan a feature", prompt: "Help me plan a feature. Ask me clarifying questions first, then produce an implementation plan." },
      { label: "🔍 Ask across my vault", prompt: "Search my vault and answer: what have I written about " },
    ];
    const grid = empty.createDiv({ cls: "cc-empty-examples" });
    for (const ex of examples) {
      const card = grid.createEl("button", { cls: "cc-example", text: ex.label });
      card.addEventListener("click", () => {
        if (ex.needsActiveNote && !this.app.workspace.getActiveFile()) {
          new Notice("Open a note first, then try this one.");
          return;
        }
        this.inputEl.value = ex.prompt;
        this.inputEl.focus();
        this.deps.autosizeInput();
        this.deps.updateUsageBar();
        // A trailing-space prompt (the vault-search one) waits for the user to type.
        if (!ex.prompt.endsWith(" ")) void this.deps.onSend();
      });
    }
  }

  private async renderContextualWorkspace(mount: HTMLElement): Promise<void> {
    const workspace = await this.plugin.companionWorkspaceContext();
    if (!mount.isConnected || this.messages.length > 0 || !workspace) return;
    mount.empty();
    const card = mount.createEl("section", { cls: `cc-context-workspace is-${workspace.kind}`, attr: { "aria-label": "Current Companion workspace" } });
    card.createDiv({ cls: "cc-context-workspace-eyebrow", text: workspace.eyebrow });
    card.createEl("h3", { text: workspace.title });
    card.createEl("p", { text: workspace.description });
    card.createDiv({ cls: "cc-context-workspace-meta", text: workspace.meta });
    const actions = card.createDiv({ cls: "cc-context-workspace-actions" });
    const primary = actions.createEl("button", { cls: "mod-cta", text: workspace.primaryAction });
    const secondary = actions.createEl("button", { text: workspace.secondaryAction });
    if (workspace.kind === "research") {
      primary.addEventListener("click", () => void this.plugin.activateResearchDesk(workspace.contextPath));
      secondary.addEventListener("click", () => void this.deps.prepareWorkspaceQuestion(workspace));
    } else {
      primary.addEventListener("click", () => void this.deps.prepareWorkspaceQuestion(workspace));
      secondary.addEventListener("click", () => void this.plugin.activateRelatedView());
    }
  }

  /** Surface the setup card on a blocked send without losing the typed text. */
  showSetupCard(): void {
    const existing = this.messagesEl.querySelector<HTMLElement>(".cc-setup-card");
    if (existing) {
      existing.addClass("cc-setup-attn");
      window.setTimeout(() => existing.removeClass("cc-setup-attn"), 900);
      return;
    }
    this.deps.renderSetupCard(this.messagesEl);
    this.scrollToBottom();
  }

  /** Adapt this view to the TurnRenderer host contract (one per turn). */
  private turnHost(): TurnRendererHost {
    return {
      renderMarkdownInto: (el, md) => this.deps.renderMarkdownInto(el, md),
      renderStreamingArtifactInto: (el, buffer) => this.deps.renderStreamingArtifactInto(el, buffer),
      scrollToBottom: () => this.scrollToBottom(),
      clearThinkingStatus: () => this.clearThinkingStatus(),
      createThinkingPanel: (bubble) => this.createThinkingPanel(bubble),
      annotateTruncated: (bubble) => this.annotateTruncated(bubble),
      mergeTurnUsage: (usage) => {
        this.turn.turnUsage = mergeUsage(this.turn.turnUsage ?? undefined, usage);
      },
      syncBuffer: (buffer) => {
        this.turn.lastBuffer = buffer;
      },
    };
  }

  /**
   * Subscribe this view's bubble/body to a conversation's live turn: the
   * replay buffer renders first, then live events, through the same
   * TurnRenderer/tool-chips pipeline a same-view run() used to drive directly.
   * Returns the unsubscribe — self-invoked once the turn settles.
   */
  startTurnRendering(conversationId: string, bubble: HTMLElement, body: HTMLElement, wantThinking: boolean, turnService: ChatTurnService): () => void {
    const renderer = new TurnRenderer(this.turnHost(), bubble, body, wantThinking);
    const chips = this.createToolChips(bubble, body);
    let unsubscribe: () => void = () => undefined;
    const settle = (result: AgentTurnResult): void => {
      void this.settleTurnRendering(conversationId, bubble, body, renderer, result).finally(() => {
        unsubscribe();
        if (this.turn.turnRenderUnsubscribe === unsubscribe) this.turn.turnRenderUnsubscribe = null;
      });
    };
    const apply = (event: TurnEvent): void => {
      switch (event.kind) {
        case "text": renderer.onText(event.delta); break;
        case "thinking": renderer.onThinking(event.delta); break;
        case "toolStart": chips.start(event.block); break;
        case "toolResult": chips.finish(event.block, event.result); renderer.markToolBoundary(); break;
        case "notice": this.annotateAgentNotice(bubble, event.text); break;
        case "usage": renderer.onUsage(event.usage); break;
        case "truncated": renderer.onTruncated(); break;
        case "done": settle(event.result); break;
        case "error": settle({ text: renderer.buffer, trace: [], error: event.error }); break;
      }
    };
    unsubscribe = turnService.subscribe(conversationId, (message) => {
      if (message.kind === "replay") { for (const e of message.events) apply(e); return; }
      apply(message);
    });
    return unsubscribe;
  }

  /** The DOM-only half of finishing a turn: final render, persisted-message push (view-local), error box. Persistence itself runs through ChatTurnService's completeTurn/interruptTurn regardless of whether this fires. */
  private async settleTurnRendering(
    conversationId: string,
    bubble: HTMLElement,
    body: HTMLElement,
    renderer: TurnRenderer,
    result: AgentTurnResult,
  ): Promise<void> {
    // Idempotent per bubble: "done"/"error" and a stale replay can both reach
    // here for the same turn — only the first call commits the message + actions.
    if (bubble.dataset.ccFinished === "1") return;
    bubble.dataset.ccFinished = "1";
    this.clearThinkingStatus();

    // Never persist a half-generated HTML artifact fence left by an abort.
    const incompleteArtifact = !!result.aborted && hasIncompleteHtmlArtifactFence(result.text);
    if (incompleteArtifact) {
      this.renderInterruptedArtifact(body);
    } else {
      try {
        await renderer.finalize(result.text);
      } catch {
        body.setText(result.text);
      }
    }
    const full = !incompleteArtifact && result.text.trim().length > 0 ? result.text : null;
    if (full) {
      this.messages.push({ role: "assistant", content: full, ...(result.trace.length > 0 ? { toolTrace: result.trace } : {}) });
      this.addAssistantActions(bubble, full);
    }
    if (result.error && !full) {
      const providerId = (result.error as Error & { ccProvider?: ErrorHintProvider }).ccProvider ?? "anthropic";
      this.renderError(body, result.error.message || "Request failed", providerId);
      this.deps.restoreMediaAfterFailure();
    }
    if (this.turn.currentTurn?.conversationId === conversationId) {
      this.turn.unregisterCurrentTurn = null;
      this.turn.currentTurn = null;
      this.deps.setSending(false);
      this.turn.abort = null;
    }
    // Fold this turn's usage into the session exactly once. The API emits usage
    // on both message_start and message_delta; counting each event would double
    // the request count and inflate output tokens.
    if (this.turn.turnUsage) {
      this.turn.session = addUsage(this.turn.session, this.turn.turnUsage);
      this.turn.turnUsage = null;
    }
    this.deps.updateUsageBar();
    this.scrollToBottom();
  }

  /** Live tool chips for the in-flight agent turn, inserted above the answer body. */
  private createToolChips(bubble: HTMLElement, body: HTMLElement) {
    let container: HTMLElement | null = null;
    const open = new Map<string, HTMLElement>();
    const ensure = (): HTMLElement => {
      if (!container) {
        container = bubble.createDiv({ cls: "cc-tool-chips" });
        bubble.insertBefore(container, body);
      }
      return container;
    };
    return {
      start: (block: ToolUseBlock): void => {
        const chip = ensure().createEl("details", { cls: "cc-tool-chip is-running" });
        chip.createEl("summary", { cls: "cc-tool-chip-summary", text: chipLabel(block.name, block.input) });
        open.set(block.id, chip);
        this.scrollToBottom();
      },
      finish: (block: ToolUseBlock, result: ToolResultBlock): void => {
        const chip = open.get(block.id);
        if (!chip) return;
        chip.removeClass("is-running");
        if (result.is_error) chip.addClass("is-error");
        chip.createEl("pre", { cls: "cc-tool-chip-result", text: previewText(result.content) });
      },
    };
  }

  /** Re-render persisted tool chips (from a message's toolTrace) on replay. */
  private renderTraceChips(bubble: HTMLElement, body: HTMLElement, trace: ToolTraceEntry[]): void {
    const container = bubble.createDiv({ cls: "cc-tool-chips" });
    bubble.insertBefore(container, body);
    for (const t of trace) {
      const chip = container.createEl("details", { cls: `cc-tool-chip${t.ok ? "" : " is-error"}` });
      chip.createEl("summary", { cls: "cc-tool-chip-summary", text: chipLabel(t.name, t.argsSummary) });
      chip.createEl("pre", { cls: "cc-tool-chip-result", text: t.resultPreview });
    }
  }

  /** Muted status line under an agent turn (iteration cap, early end). */
  private annotateAgentNotice(bubble: HTMLElement, text: string): void {
    bubble.createDiv({ cls: "cc-agent-notice", text });
  }

  renderInterruptedTurn(conversation: Conversation): void {
    const row = this.messagesEl.createDiv({ cls: "cc-agent-notice cc-interrupted-turn" });
    row.createSpan({ text: "This task was interrupted. Review any partial changes before resuming." });
    const resume = row.createEl("button", { text: "Resume", cls: "mod-cta" });
    resume.addEventListener("click", () => void this.deps.resumeInterruptedTurn(conversation));
  }

  /** The round spark mark before an assistant bubble's content (screen-reader label "Claude" is carried by .cc-role, not this icon). */
  private addSparkMark(bubble: HTMLElement): void {
    setIcon(bubble.createSpan({ cls: "cc-spark" }), "sparkles");
  }

  createAssistantBubble(): { bubble: HTMLElement; body: HTMLElement } {
    const bubble = this.messagesEl.createDiv({ cls: "cc-msg cc-assistant" });
    bubble.createDiv({ cls: "cc-role", text: "Claude" });
    this.addSparkMark(bubble);
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
      word.setText(`${Transcript.CLAUDIAN[i % Transcript.CLAUDIAN.length]}…`);
      i++;
    };
    tick();
    this.clearThinkingStatus();
    // 3000ms = the 20-bpm word-fade period, so the swap lands at the fade trough.
    this.thinkingTimer = window.setInterval(tick, 3000);
  }

  clearThinkingStatus(): void {
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

  renderMessage(role: "user" | "assistant", text: string, opts?: { command?: boolean }): void {
    if (this.messages.length === 1) this.messagesEl.empty();
    const bubble = this.messagesEl.createDiv({ cls: `cc-msg cc-${role}${opts?.command ? " cc-command" : ""}` });
    if (opts?.command) {
      this.renderCommandChip(bubble, text);
      this.scrollToBottom();
      return;
    }
    bubble.createDiv({ cls: "cc-role", text: role === "user" ? "You" : "Claude" });
    if (role === "assistant") this.addSparkMark(bubble);
    const body = bubble.createDiv({ cls: "cc-body" });
    void this.deps.renderMarkdownInto(body, text);
    this.scrollToBottom();
  }

  /** A slash command / workflow invocation renders as a compact accent chip
   *  (e.g. "/summarize") instead of a plain user bubble of raw prompt text. */
  private renderCommandChip(bubble: HTMLElement, label: string): void {
    const chip = bubble.createDiv({ cls: "cc-command-chip" });
    setIcon(chip.createSpan({ cls: "cc-command-chip-icon" }), "terminal");
    chip.createSpan({ cls: "cc-command-chip-label", text: label });
  }

  private renderError(body: HTMLElement, message: string, provider: ErrorHintProvider): void {
    // Append below any partial streamed content — never destroy what arrived.
    // But a failure before the first token leaves the "thinking" indicator in
    // place; drop it so the bubble doesn't show both a spinner and the error.
    body.querySelector(".cc-thinking-status")?.remove();
    const box = body.createDiv({ cls: "cc-error" });
    box.createSpan({ cls: "cc-error-title", text: "Couldn’t reach the model" });
    box.createSpan({ text: message });
    const hint = errorHint(message, provider);
    if (hint) box.createDiv({ cls: "cc-error-hint", text: hint });
    if (this.lastUserText) {
      const retry = box.createEl("button", { cls: "cc-error-retry", text: "Retry" });
      retry.addEventListener("click", () => void this.deps.regenerate());
    }
  }

  /** Flag a reply that the model truncated at the output-token limit. */
  private annotateTruncated(bubble: HTMLElement): void {
    if (bubble.querySelector(".cc-truncated-note")) return;
    const cap = this.controls?.maxTokens ?? this.plugin.settings.maxTokens;
    const note = bubble.createDiv({ cls: "cc-truncated-note" });
    note.createSpan({ cls: "cc-truncated-title", text: "Response hit the output-token limit" });
    note.createSpan({ text: ` — it was cut off at ${cap} tokens.` });
    const retry = note.createEl("button", { cls: "cc-error-retry", text: "Retry with a higher limit" });
    retry.addEventListener("click", () => void this.deps.regenerate({ maxTokens: Math.min(cap * 2, 64000) }));
  }

  private renderInterruptedArtifact(body: HTMLElement): void {
    body.empty();
    const box = body.createDiv({ cls: "cc-error" });
    box.createSpan({ cls: "cc-error-title", text: "Artifact generation stopped" });
    box.createSpan({ text: "The HTML block did not finish, so it was not saved to the chat history." });
  }

  annotateContext(sources: string[]): void {
    if (sources.length === 0) return;
    const last = this.messagesEl.lastElementChild;
    if (!last) return;
    last.createDiv({ cls: "cc-context-note", text: `+ context: ${sources.join(", ")}` });
  }

  private addAssistantActions(bubble: HTMLElement, full: string): void {
    bubble.querySelectorAll(":scope > .cc-actions").forEach((el) => el.remove());
    // Per-code-block copy buttons inside the rendered markdown.
    this.decorateCodeBlocks(bubble);

    const bar = bubble.createDiv({ cls: "cc-actions" });
    this.actionBtn(bar, "Copy", "copy", () => {
      void navigator.clipboard.writeText(full);
      quickNotice("Copied to clipboard");
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
    // A plan reply (has a `## Build tasks` checklist) gets execution buttons:
    // "Implement" runs the tasks in-app via agent mode (vault work); "Build"
    // hands the plan off to Claude Code (code work outside the vault).
    if (extractTasks(full).length > 0) {
      const impl = this.actionBtn(bar, "Implement", "play", () => void this.implementFromReply(full));
      impl.addClass("cc-accent");
      this.actionBtn(bar, "Build", "hammer", () => void this.buildFromReply(full));
    }
    // Regenerate the last reply (only on the most recent assistant message).
    const tail = this.messages[this.messages.length - 1];
    const isLast = tail?.role === "assistant";
    if (isLast && this.lastUserText) {
      this.actionBtn(bar, "Regenerate", "refresh-cw", () => void this.deps.regenerate());
    }
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

  private actionBtn(bar: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
    const btn = bar.createEl("button", { cls: "cc-action clickable-icon", attr: { "aria-label": label, title: label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * Execute the plan in-app: feed its build tasks back through agent mode so
   * Claude actually does the vault work (create/edit notes, canvases, bases) —
   * each write still confirms. Needs agent mode + Claude; otherwise points the
   * user at the Build (Claude Code) handoff instead.
   */
  private async implementFromReply(full: string): Promise<void> {
    if (this.streaming) return;
    if (!this.plugin.settings.agentModeEnabled || !this.plugin.router().chatCapabilities().agentActions) {
      new Notice("Turn on agent mode (and use Claude or Claude Code) to implement in-app, or use Build to hand off to Claude Code.");
      return;
    }
    if (!this.plugin.settings.agentAllowWrites) {
      new Notice("Turn on “Act on vault” to let me make the changes, then hit Implement again.");
      return;
    }
    const tasks = extractTasks(full);
    const list = tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
    const prompt =
      "Implement the plan above by actually doing the work in my vault. Go through these build tasks in order, " +
      "using your vault tools to create and edit the notes/canvases/bases each one calls for — don't just re-describe the plan. " +
      "Note briefly what you changed after each. If a task requires code changes outside the vault, say so and skip it.\n\n" +
      `Tasks:\n${list}`;
    await this.deps.submitPrompt(prompt, "Implement plan");
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

  /**
   * Index a document for durable storage: tags + a one-line summary, generated
   * by the utility provider (local Ollama when available, else Claude — heavy
   * lifting offloads automatically). Best-effort: never blocks a save.
   */
  private async maybeIndex(content: string): Promise<{ tags: string[]; summary?: string; title?: string }> {
    if (!this.plugin.settings.autoTagOnSave) return { tags: [] };
    try {
      const { summarizeAndTag, existingVaultTags } = await import("../../indexing/autoTagger");
      const res = await summarizeAndTag(this.plugin.router(), content, existingVaultTags(this.app));
      return {
        tags: res.tags,
        ...(res.summary ? { summary: res.summary } : {}),
        ...(res.title ? { title: res.title } : {}),
      };
    } catch (e) {
      console.debug("Claude Companion: auto-tag failed", e);
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

  private insertIntoNote(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note to insert into.");
      return;
    }
    view.editor.replaceSelection(text);
    quickNotice("Inserted into note");
  }

  async saveChat(): Promise<void> {
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
}
