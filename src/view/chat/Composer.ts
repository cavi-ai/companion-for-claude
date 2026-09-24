import { Platform, setIcon, MarkdownView, Notice, TFile, type App } from "obsidian";
import { type SlashCommand, parseSlashQuery } from "../slashCommands";
import { SlashMenu } from "../SlashMenu";
import { AtMenu } from "../AtMenu";
import { type AtItem, type ClaimAtSource, type ProjectAtSource, buildAtItems, buildClaimItems, activeAtQuery, activeHashQuery } from "../../context/atMention";
import type { ChatProject } from "../../projects/model";
import { ComposerContextManager } from "../ComposerContextManager";
import { type AutomaticContextKey, buildContextManagerModel } from "../contextManagerModel";
import { ModeControl, type ChatMode } from "../ModeControl";
import type { AttachedPath } from "../../context/vaultContext";
import { type MediaAttachment, arrayBufferToBase64, maxBytesFor, mediaBlock, mediaKind, mediaMime, sniffMime } from "../../context/attachments";
import { type AttachedPage, detectPageUrl, pageLabel } from "../../context/urlContext";
import type { ContentBlock } from "../../providers/types";
import { CLAUDE_MODELS } from "../../claude/models";
import { capabilitiesFor, effortLevels } from "../../claude/capabilities";
import { type ChatControls, knobVisibility } from "../../claude/chatControls";
import { mergeDetectedModels } from "../../providers/localModels";
import { quickNotice } from "../../notice";
import type ClaudeCompanionPlugin from "../../main";

export interface ComposerDeps {
  applyChatFontSize(): void;
  applyMode(mode: ChatMode): Promise<void>;
  currentMode(): ChatMode;
  onModelSelect(value: string): Promise<void>;
  refreshCapabilityIndicators(): void;
  registerDomEvent(el: Document, type: "click", callback: (evt: MouseEvent) => void): void;
  resolveMarkdownContextView(): MarkdownView | null;
  updateModeControl(): void;
  updateUsageBar(): void;
  cachedClaims(): ClaimAtSource[];
  cachedProjects(): ProjectAtSource[];
  controls(): ChatControls;
  streaming(): boolean;
  mountUsage(parent: HTMLElement): void;
  onSlashCommand(cmd: SlashCommand): void;
  pickAtItems(): AtItem[];
  onAtChoose(item: AtItem): void;
  toggleAutomatic(key: AutomaticContextKey, enabled: boolean): void;
  removeSource(id: string): void;
  retrySource(id: string): void;
  addContext(): void;
  onSend(): void;
  syncSlashMenu(): void;
  /** Choose a chat project from the "@" menu, or clear it (the pill's remove ×) when `id` is null. */
  chooseProject(id: string | null): void;
}

/** The composer: input, @/slash menus, attachments/context manager, quick options, submit. */
export class Composer {
  el!: HTMLElement;
  inputEl!: HTMLTextAreaElement;
  sendBtn!: HTMLButtonElement;
  atMenu!: AtMenu;
  slashMenu!: SlashMenu;
  contextManager!: ComposerContextManager;
  controlsEl!: HTMLElement;
  knobsEl!: HTMLElement;
  reasoningEl: HTMLButtonElement | null = null;
  modeControl: ModeControl | null = null;
  pageOfferEl!: HTMLElement;
  /** URL the user declined to attach — don't re-offer while it stays in the input. */
  dismissedPageUrl: string | null = null;
  /** Notes/folders explicitly attached via "@" (session-scoped). */
  attachedPaths: AttachedPath[] = [];
  /** PDFs/images attached via "@" or paste — cleared after the next send. */
  attachedMedia: MediaAttachment[] = [];
  /** Web pages attached via "Attach page content" (captured markdown). */
  attachedPages: AttachedPage[] = [];
  /** Which trigger ("@" or "#") the open at-menu is currently showing matches for. */
  activeMenuTrigger: "@" | "#" = "@";
  /** Last visible context-manager state; skip DOM rebuilds when nothing changed. */
  lastContextManagerSignature = "";
  /** The active chat project's pill, next to the context-manager trigger; hidden when there's none. */
  projectPillEl!: HTMLElement;

  mount(
    root: HTMLElement,
    slashCommands: SlashCommand[],
  ): void {
    const composer = root.createDiv({ cls: "cc-composer" });
    this.el = composer;

    this.contextManager = new ComposerContextManager(composer, {
      toggleAutomatic: (key, enabled) => this.deps.toggleAutomatic(key, enabled),
      removeSource: (id) => this.deps.removeSource(id),
      retrySource: (id) => this.deps.retrySource(id),
      addContext: () => this.deps.addContext(),
    });
    // The active chat project's pill (same pill style as a folder attachment).
    this.projectPillEl = composer.createDiv({ cls: "cc-ctx-pill cc-ctx-project" });
    this.projectPillEl.setCssStyles({ display: "none" });
    // The "attach this page?" offer for URLs in the composer.
    this.pageOfferEl = composer.createDiv({ cls: "cc-page-offer" });
    this.pageOfferEl.setCssStyles({ display: "none" });

    // Palettes anchored above the input (built before the textarea so they sit
    // above it in flow; CSS positions them absolutely).
    // Slash is the single command surface: the built-in commands plus every vault
    // workflow (the browsable picker stays reachable via /workflows).
    this.slashMenu = new SlashMenu(composer, slashCommands, (cmd) => this.deps.onSlashCommand(cmd));
    this.atMenu = new AtMenu(composer, () => this.deps.pickAtItems(), (item) => this.deps.onAtChoose(item));

    // Mobile keeps the compact input row; the context manager above is the one
    // button-driven source entry point on every platform.
    const inputRow = Platform.isMobile ? composer.createDiv({ cls: "cc-composer-input-row" }) : composer;
    this.inputEl = inputRow.createEl("textarea", {
      cls: "cc-input",
      // Start compact on mobile (1 row, grows via autosizeInput) so the composer
      // doesn't eat a big band of the phone screen; roomier default on desktop.
      // The desktop placeholder spells out the /@ affordances, but that string
      // wraps to two cramped lines inside a one-row phone pill — mobile gets a
      // short placeholder (the "+" button already surfaces context on mobile).
      attr: {
        placeholder: Platform.isMobile
          ? "Message Claude…"
          : "Ask Claude…  ( / for commands · @ to add context · Enter to send )",
        rows: Platform.isMobile ? "1" : "3",
      },
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
      // Desktop: Enter sends, Shift+Enter breaks a line. Mobile soft keyboards
      // have no Shift — Enter inserts a newline and only the send button sends.
      if (e.key === "Enter" && !e.shiftKey && !Platform.isMobile) {
        e.preventDefault();
        this.deps.onSend();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.autosizeInput();
      this.deps.updateUsageBar();
      this.deps.syncSlashMenu();
      this.syncAtMenu();
      this.syncPageOffer();
    });
    // Close the menus when focus leaves the composer.
    this.inputEl.addEventListener("blur", () => window.setTimeout(() => { this.slashMenu.hide(); this.atMenu.hide(); }, 120));
    // Paste a screenshot/image straight into the composer to attach it.
    this.inputEl.addEventListener("paste", (evt: ClipboardEvent) => {
      const items = evt.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            evt.preventDefault();
            void this.attachPastedImage(file);
          }
          return;
        }
      }
    });

    // ---- composer bar: model + tune (left group) · usage + Send (right) ----
    // Desktop: one row under the input. Mobile: Send joins the thumb input row
    // ([+] · input · ↑); the bar keeps only the thin usage gauge (see styles).
    const bar = composer.createDiv({ cls: "cc-composer-bar" });
    this.controlsEl = bar.createDiv({ cls: "cc-controls" });
    this.renderControls();

    const sendGroup = bar.createDiv({ cls: "cc-send-group" });
    this.deps.mountUsage(sendGroup);
    const sendParent = Platform.isMobile ? inputRow : sendGroup;
    this.sendBtn = sendParent.createEl("button", {
      cls: Platform.isMobile ? "cc-send cc-send-icon" : "cc-send",
      ...(Platform.isMobile
        ? { attr: { "aria-label": "Send message" } }
        : { text: "Send" }),
    });
    if (Platform.isMobile) setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.addEventListener("click", () => this.deps.onSend());
  }

  destroy(): void {
    this.contextManager?.destroy();
  }

  constructor(private app: App, private plugin: ClaudeCompanionPlugin, private deps: ComposerDeps) {}

  private get cachedClaims(): ClaimAtSource[] { return this.deps.cachedClaims(); }
  private get controls(): ChatControls { return this.deps.controls(); }
  private get streaming(): boolean { return this.deps.streaming(); }

  /** Candidate sources for the "@" menu: specials, recents, notes, folders, bases, claims, media. */
  atItems(): AtItem[] {
    const notes = this.app.vault.getMarkdownFiles().map((f) => f.path);
    const folders = new Set<string>();
    for (const p of notes) {
      const i = p.lastIndexOf("/");
      if (i > 0) folders.add(p.slice(0, i));
    }
    const media = this.app.vault
      .getFiles()
      .filter((f) => mediaKind(f.path) !== null)
      .map((f) => f.path)
      .sort();
    const bases = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "base")
      .map((f) => f.path)
      .sort();
    const recents = this.app.workspace
      .getLastOpenFiles()
      .filter((p) => p.toLowerCase().endsWith(".md") && this.app.vault.getAbstractFileByPath(p) instanceof TFile)
      .slice(0, 5);
    return buildAtItems(notes, [...folders].sort(), media, bases, this.cachedClaims, recents, this.deps.cachedProjects());
  }

  /** Show/hide/update the active chat project's pill; `null` hides it. */
  setProjectPill(project: ChatProject | null): void {
    if (!this.projectPillEl) return;
    if (!project) {
      this.projectPillEl.setCssStyles({ display: "none" });
      return;
    }
    this.projectPillEl.empty();
    this.projectPillEl.createSpan({ cls: "cc-ctx-pill-label", text: project.name });
    const remove = this.projectPillEl.createEl("button", {
      cls: "cc-ctx-pill-remove",
      text: "×",
      attr: { type: "button", "aria-label": `Remove project ${project.name}` },
    });
    remove.addEventListener("click", () => this.deps.chooseProject(null));
    this.projectPillEl.setCssStyles({ display: "" });
  }

  /** Candidate sources for the "#" menu: research claims only. */
  hashItems(): AtItem[] {
    return buildClaimItems(this.cachedClaims);
  }

  /** Load attached media into wire blocks; oversize/unreadable files are skipped with a notice. */
  async mediaBlocks(): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    for (const m of this.attachedMedia) {
      try {
        let data = m.data;
        let mime = m.mime;
        if (!data && m.path) {
          const file = this.app.vault.getAbstractFileByPath(m.path);
          if (!(file instanceof TFile)) throw new Error("file not found");
          if (file.stat.size > maxBytesFor(m.kind)) {
            new Notice(`${m.label} is too large to attach (max ${Math.round(maxBytesFor(m.kind) / 1024 / 1024)} MB).`);
            continue;
          }
          const buf = await this.app.vault.readBinary(file);
          // Trust the bytes over the extension so a mislabeled file isn't 400'd.
          mime = sniffMime(buf) ?? m.mime;
          data = arrayBufferToBase64(buf);
        }
        if (data) blocks.push(mediaBlock(m.kind, mime, data));
      } catch (e) {
        new Notice(`Couldn't attach ${m.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return blocks;
  }

  /** Attach an image pasted into the composer (screenshots, copied images). */
  async attachPastedImage(file: File): Promise<void> {
    if (file.size > maxBytesFor("image")) {
      new Notice(`Pasted image is too large to attach (max ${Math.round(maxBytesFor("image") / 1024 / 1024)} MB).`);
      return;
    }
    const buf = await file.arrayBuffer();
    const data = arrayBufferToBase64(buf);
    const n = this.attachedMedia.filter((m) => !m.path).length + 1;
    this.attachedMedia.push({ label: file.name || `Pasted image ${n}`, kind: "image", mime: sniffMime(buf) ?? (file.type || "image/png"), data });
    this.renderContextManager();
    quickNotice("Image attached to your next message.");
  }

  /** Open/refresh/close the "@"/"#" picker based on the cursor's active token (innermost wins). */
  syncAtMenu(): void {
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const atHit = activeAtQuery(this.inputEl.value, cursor);
    const hashHit = activeHashQuery(this.inputEl.value, cursor);
    if (hashHit && (!atHit || hashHit.start > atHit.start)) {
      this.activeMenuTrigger = "#";
      this.atMenu.show(hashHit.query);
    } else if (atHit) {
      this.activeMenuTrigger = "@";
      this.atMenu.show(atHit.query);
    } else {
      this.atMenu.hide();
    }
  }

  /**
   * Offer "Attach page content" when the composer holds a URL. Never fetches
   * on its own — the capture only fires from the Attach click (spec §7).
   */
  syncPageOffer(): void {
    if (!this.pageOfferEl) return;
    const hide = () => this.pageOfferEl.setCssStyles({ display: "none" });
    if (this.streaming || !this.plugin.captureWebPage()) return hide();
    const url = detectPageUrl(this.inputEl.value);
    if (!url || url === this.dismissedPageUrl || this.attachedPages.some((p) => p.url === url)) return hide();

    this.pageOfferEl.empty();
    this.pageOfferEl.createSpan({ cls: "cc-page-offer-label", text: `Attach page content from ${pageLabel(url)}?` });
    const attach = this.pageOfferEl.createEl("button", { cls: "cc-page-offer-btn", text: "Attach" });
    attach.addEventListener("click", () => void this.attachPage(url));
    const dismiss = this.pageOfferEl.createEl("button", { cls: "cc-page-offer-dismiss", text: "×", attr: { "aria-label": "Dismiss" } });
    dismiss.addEventListener("click", () => {
      this.dismissedPageUrl = url;
      hide();
    });
    this.pageOfferEl.setCssStyles({ display: "" });
  }

  /** Capture a URL into an attached page. Errors land on the pill, not the chat. */
  private async attachPage(url: string): Promise<void> {
    const capture = this.plugin.captureWebPage();
    if (!capture) return;
    this.pageOfferEl.setCssStyles({ display: "none" });
    if (this.attachedPages.some((p) => p.url === url)) return;
    const page: AttachedPage = { url, markdown: "" };
    this.attachedPages.push(page);
    await this.captureAttachedPage(page);
  }

  private async captureAttachedPage(page: AttachedPage): Promise<void> {
    const capture = this.plugin.captureWebPage();
    if (!capture) return;
    page.pending = true;
    delete page.error;
    this.renderContextManager();
    try {
      const result = await capture(page.url);
      if (!result) {
        page.error = "No readable content on that page.";
      } else {
        page.markdown = result.markdown;
        if (result.title) page.title = result.title;
      }
    } catch (e) {
      page.error = e instanceof Error ? e.message : String(e);
    } finally {
      page.pending = false;
      this.renderContextManager();
      this.deps.updateUsageBar();
    }
  }

  /** Apply a chosen "@"/"#" source: toggle a context flag or attach a note/folder. */
  async onAtChoose(item: AtItem): Promise<void> {
    // Strip the "@query"/"#query" token the user typed.
    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const hit = this.activeMenuTrigger === "#" ? activeHashQuery(this.inputEl.value, cursor) : activeAtQuery(this.inputEl.value, cursor);
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
    else if (item.kind === "project" && item.path) {
      this.deps.chooseProject(item.path);
      return; // chooseProject persists + re-renders the context row asynchronously
    }
    // note-path/folder-path (explicit attach), recent (a recently opened note), base-path
    // (.base file) and claim (a research claim's note) all resolve to the same attach:
    // a note by path, deduped against anything already attached at that path.
    else if (item.path && (item.kind === "note-path" || item.kind === "folder-path" || item.kind === "recent" || item.kind === "base-path" || item.kind === "claim")) {
      const kind = item.kind === "folder-path" ? "folder" : "note";
      if (!this.attachedPaths.some((a) => a.path === item.path && a.kind === kind)) {
        this.attachedPaths.push({ path: item.path, kind });
      }
    } else if (item.path && item.kind === "media-path") {
      const kind = mediaKind(item.path);
      if (kind && !this.attachedMedia.some((m) => m.path === item.path)) {
        this.attachedMedia.push({ label: item.label, kind, mime: mediaMime(item.path), path: item.path });
      }
    }
    await this.plugin.saveSettings();
    this.renderContextManager();
    this.deps.updateUsageBar();
  }

  renderContextManager(): void {
    if (!this.contextManager) return;
    const active = this.deps.resolveMarkdownContextView()?.file ?? this.app.workspace.getActiveFile();
    const model = buildContextManagerModel({
      toggles: this.plugin.settings.context,
      activeNotePath: active?.path ?? null,
      paths: this.attachedPaths,
      media: this.attachedMedia,
      pages: this.attachedPages,
    });
    if (model.signature === this.lastContextManagerSignature) return;
    this.lastContextManagerSignature = model.signature;
    this.contextManager.render(model);
  }

  toggleAutomaticContext(key: AutomaticContextKey, enabled: boolean): void {
    this.plugin.settings.context[key] = enabled;
    void this.plugin.saveSettings();
    this.renderContextManager();
    this.deps.updateUsageBar();
  }

  removeContextSource(id: string): void {
    const active = this.deps.resolveMarkdownContextView()?.file ?? this.app.workspace.getActiveFile();
    const model = buildContextManagerModel({
      toggles: this.plugin.settings.context,
      activeNotePath: active?.path ?? null,
      paths: this.attachedPaths,
      media: this.attachedMedia,
      pages: this.attachedPages,
    });
    const index = model.sources.findIndex((source) => source.id === id);
    if (index < 0) return;
    if (index < this.attachedPaths.length) this.attachedPaths.splice(index, 1);
    else if (index < this.attachedPaths.length + this.attachedMedia.length) this.attachedMedia.splice(index - this.attachedPaths.length, 1);
    else this.attachedPages.splice(index - this.attachedPaths.length - this.attachedMedia.length, 1);
    this.renderContextManager();
    this.deps.updateUsageBar();
  }

  retryContextSource(id: string): void {
    const page = this.attachedPages.find((candidate) => `page:${candidate.url}` === id);
    if (page) void this.captureAttachedPage(page);
  }

  openContextPicker(): void {
    this.contextManager.close({ restoreFocus: false });
    this.inputEl.focus();
    const value = this.inputEl.value;
    const needsSpace = value.length > 0 && !value.endsWith(" ");
    this.inputEl.value = `${value}${needsSpace ? " " : ""}@`;
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
    this.inputEl.dispatchEvent(new Event("input"));
  }

  /**
   * Render the per-message control row. The visible knobs adapt to the selected
   * model's capabilities, so a control that the model would 400 on is hidden
   * rather than shown-and-broken. Ollama (local) sessions show no Claude knobs.
   */
  renderControls(): void {
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
    select.addEventListener("change", () => void this.deps.onModelSelect(select.value));
    // Pull in detected Ollama models so a local model can be picked here without
    // opening settings. Async — appended once the local server answers.
    void this.appendLocalModelOptions(select);
    void this.appendCustomModelOptions(select);

    // Reasoning indicator: lit when the current backend thinks before
    // answering (Claude thinking on, or a local model with thinking metadata).
    const reasoning = this.controlsEl.createEl("button", {
      cls: "cc-ctl cc-reasoning-indicator",
      attr: { "aria-label": "Reasoning status", tabindex: "-1" },
    });
    setIcon(reasoning, "brain");
    this.reasoningEl = reasoning;
    this.deps.refreshCapabilityIndicators();

    // Ask / Plan / Act — one segmented control for whether Claude can create /
    // edit notes in chat. Only meaningful for Claude (Ollama has no vault
    // tools), so it hides itself on local sessions. Each write still asks for
    // confirmation; Act just controls whether the tools are offered.
    this.modeControl = new ModeControl(this.controlsEl, {
      initial: this.deps.currentMode(),
      onChange: (m) => this.deps.applyMode(m),
    });
    this.deps.updateModeControl();

    // Knobs (thinking / effort / temp / max) live in a popover behind a single
    // "tune" button, so the footer stays clean and Send is never buried.
    const tuneWrap = this.controlsEl.createDiv({ cls: "cc-tune" });
    const tuneBtn = tuneWrap.createEl("button", {
      cls: "cc-icon-btn clickable-icon cc-tune-btn",
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
    this.deps.registerDomEvent(activeDocument, "click", (e) => {
      if (this.knobsEl?.hasClass("is-open") && !tuneWrap.contains(e.target as Node)) {
        this.knobsEl.removeClass("is-open");
        tuneBtn.setAttr("aria-expanded", "false");
      }
    });
  }

  /** Append a "Local (Ollama)" optgroup of detected models to the switcher. */
  private async appendLocalModelOptions(select: HTMLSelectElement): Promise<void> {
    let detected: string[];
    try {
      detected = await this.plugin.router().ollama.listModels();
    } catch (e) {
      console.debug("Claude Companion: Ollama model listing failed", e);
      detected = [];
    }
    const configured = this.plugin.settings.ollamaModel;
    const models = mergeDetectedModels(detected, configured);
    if (!models.length || !select.isConnected) return;
    const group = select.createEl("optgroup", { attr: { label: "Local (Ollama)" } });
    for (const m of models) group.createEl("option", { value: `ollama:${m}`, text: `${m} · local` });
    // Now that local options exist, reflect the active backend in the selection.
    if (this.plugin.settings.chatBackend === "local" && configured) select.value = `ollama:${configured}`;
  }

  /**
   * Append a "Local (endpoint)" optgroup for the OpenAI-compatible server —
   * every model it reports, so one can be picked here without knowing its id.
   */
  private async appendCustomModelOptions(select: HTMLSelectElement): Promise<void> {
    if (!this.plugin.settings.openaiCompatHost.trim()) return;
    let detected: string[];
    try {
      detected = await this.plugin.router().openaiCompat.listModels();
    } catch (e) {
      console.debug("Claude Companion: custom endpoint model listing failed", e);
      detected = [];
    }
    const configured = this.plugin.settings.openaiCompatModel;
    const models = mergeDetectedModels(detected, configured);
    if (!models.length || !select.isConnected) return;
    const group = select.createEl("optgroup", { attr: { label: "Local (endpoint)" } });
    for (const m of models) group.createEl("option", { value: `custom:${m}`, text: `${m} · endpoint` });
    const active = configured.trim() || models[0];
    if (this.plugin.settings.chatBackend === "custom" && active) select.value = `custom:${active}`;
  }

  /** Rebuild only the capability-dependent knobs into the given container. */
  renderKnobsInto(parent: HTMLElement): void {
    parent.empty();

    // Chat text size — provider-independent, so it sits above the model knobs
    // (and stays available on local sessions). Drives --cc-chat-font live.
    const fontWrap = parent.createDiv({ cls: "cc-ctl cc-ctl-font", attr: { "aria-label": "Chat text size" } });
    fontWrap.createSpan({ cls: "cc-ctl-label", text: "text" });
    const font = fontWrap.createEl("input", {
      cls: "cc-ctl-range",
      attr: { type: "range", min: "11", max: "20", step: "1", "aria-label": "Chat text size (px)" },
    });
    const fontOut = fontWrap.createSpan({ cls: "cc-ctl-val" });
    font.value = String(this.plugin.settings.chatFontSize);
    fontOut.setText(`${this.plugin.settings.chatFontSize}px`);
    font.addEventListener("input", () => {
      const px = parseInt(font.value, 10);
      this.plugin.settings.chatFontSize = px;
      fontOut.setText(`${px}px`);
      this.deps.applyChatFontSize(); // live
    });
    font.addEventListener("change", () => void this.plugin.saveSettings());

    const controlCaps = this.plugin.router().chatCapabilities();
    if (!controlCaps.claudeControls) {
      parent.createSpan({ cls: "cc-ctl-note", text: controlCaps.cli ? "Claude Code owns thinking and effort for this backend" : "local model · Claude controls apply when routed to Claude" });
      return;
    }

    const caps = capabilitiesFor(this.controls.model);
    const knobs = knobVisibility(caps, this.controls);

    if (knobs.think) {
      const think = parent.createEl("button", { cls: "cc-ctl cc-ctl-toggle", text: "Think", attr: { "aria-label": "Extended thinking" } });
      think.toggleClass("is-active", this.controls.thinking);
      think.addEventListener("click", () => {
        this.controls.thinking = !this.controls.thinking;
        this.renderKnobsInto(parent);
        this.deps.updateUsageBar();
        this.deps.refreshCapabilityIndicators();
      });

      if (knobs.effort) {
        const eff = parent.createEl("select", { cls: "cc-ctl cc-ctl-select", attr: { "aria-label": "Effort" } });
        for (const level of effortLevels(caps)) eff.createEl("option", { value: level, text: `effort: ${level}` });
        if (!effortLevels(caps).includes(this.controls.effort)) this.controls.effort = "high";
        eff.value = this.controls.effort;
        eff.addEventListener("change", () => {
          this.controls.effort = eff.value;
        });
      }

      if (knobs.showReasoning) {
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
      this.deps.updateUsageBar();
    });
  }

  /** Rebuild only the capability-dependent knobs (keeps the model select stable). */
  renderKnobs(): void {
    if (this.knobsEl) this.renderKnobsInto(this.knobsEl);
  }

  /** Grow the composer with its content (1→~8 rows), then stop and scroll. */
  autosizeInput(): void {
    const el = this.inputEl;
    if (!el) return;
    el.setCssStyles({ height: "auto" });
    // Phone: ~6 rows then internal scroll, so the composer never eats the
    // reading surface; desktop gets ~8 rows.
    const max = Platform.isMobile ? 132 : 200;
    el.setCssStyles({ height: `${Math.min(el.scrollHeight, max)}px` });
  }

  /** Open/refresh/close the slash palette based on the current input. */
  syncSlashMenu(): void {
    const q = parseSlashQuery(this.inputEl.value);
    if (q === null) this.slashMenu.hide();
    else this.slashMenu.show(q);
  }

  anyContextEnabled(): boolean {
    const c = this.plugin.settings.context;
    return c.activeNote || c.selection || c.linkedNotes || c.searchVault || this.attachedPaths.length > 0 || this.attachedMedia.length > 0 || this.attachedPages.length > 0;
  }
}
