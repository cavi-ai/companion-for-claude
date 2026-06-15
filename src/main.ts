import { App, FileSystemAdapter, MarkdownView, Modal, Notice, Platform, Plugin, requestUrl, WorkspaceLeaf } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./view/ChatView";
import { MemoryView, MEMORY_VIEW_TYPE } from "./view/MemoryView";
import { RelatedView, RELATED_VIEW_TYPE } from "./view/RelatedView";
import { SessionPicker } from "./view/SessionPicker";
import { WorkflowPicker } from "./view/WorkflowPicker";
import { WORKFLOWS, type Workflow } from "./workflows/catalog";
import { listSessionsForVault, type SessionMeta } from "./memory/sessions";
import { ingestSession, ingestConversation } from "./memory/ingest";
import { ClaudeCompanionSettingTab } from "./settings";
import { ProviderRouter } from "./providers/router";
import { DEFAULT_SETTINGS, type PluginSettings, type ArtifactOpenTarget } from "./types";
import { DESIGN_SYSTEM_PROMPT, PLANNING_INSTRUCTION } from "./artifacts/designSystem";
import { renderArtifactInline, ArtifactModal, openArtifactExternally } from "./artifacts/renderInline";
import type { McpHttpServer } from "./mcp/server";
import { VaultTools } from "./mcp/vaultTools";
import { generateToken, resolveMcpToken } from "./mcp/clientConfig";
import { extractTasks, specBody, claudeCodeBuildCommand, type SpecInput } from "./build/spec";
import { trackerArtifact } from "./build/tracker";
import { type CloudDispatchConfig, buildFireRequest, parseFireResponse, composeDispatchText, configError } from "./cloud/routines";
import { type RepliesConfig, buildContentsRequest, parseDirListing, parseFileResponse, isMarkdown, configError as repliesConfigError } from "./cloud/replies";
import { buildFrontmatter, normalizeTags } from "./indexing/frontmatter";
import { SemanticIndexer, type IndexFile } from "./semantic/indexer";
import type { IndexData } from "./semantic/store";
import {
  type Conversation,
  type ConversationState,
  emptyState,
  fromPersisted,
  getActive,
  newConversation,
  saveConversation,
  deleteConversation as removeConversation,
  setActive,
  touch,
} from "./conversations/store";
import type { ChatMessage } from "./types";
import { normalizePath, TFile } from "obsidian";

/** Output-token ceiling for artifact-producing flows (plans, artifacts, workflows),
 *  which routinely run past the chat default. A ceiling, not a target — you only
 *  pay for what's generated. Within current models' max-output limits. */
// Artifacts/plans are long (rich layout + inline script); give generous output
// headroom so a tabbed document finishes instead of truncating into broken JS.
const ARTIFACT_MAX_TOKENS = 32000;

/** Shape of this plugin's persisted data.json (settings + chat history). */
interface PersistedData {
  settings?: Partial<PluginSettings>;
  conversations?: Conversation[];
  activeConversationId?: string | null;
}

export default class ClaudeCompanionPlugin extends Plugin {
  override settings: PluginSettings = DEFAULT_SETTINGS;
  private convState: ConversationState = emptyState();
  private convSeq = 0;
  private _router: ProviderRouter | null = null;
  private mcpServer: McpHttpServer | null = null;
  private vaultTools: VaultTools | null = null;
  /** Serializes overlapping syncMcpServer() calls (settings fire it per keystroke). */
  private mcpSyncChain: Promise<void> = Promise.resolve();
  /** Signature of the currently-running MCP server, to skip needless restarts. */
  private mcpSignature: string | null = null;
  /** Lazily-built semantic index (local embeddings); null until first use. */
  private _indexer: SemanticIndexer | null = null;
  /** Embedding model the live indexer was built for (rebuild on change). */
  private indexerModel: string | null = null;
  /** Debounce timer for incremental re-index on note changes. */
  private reindexTimer: number | null = null;
  private reindexQueue = new Set<string>();

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));
    if (!Platform.isMobile) this.registerView(MEMORY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new MemoryView(leaf, this));
    this.registerView(RELATED_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RelatedView(leaf, this));

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

    // One ribbon icon for the plugin itself. Workflows and session capture live
    // in the chat panel's header action bar, so they don't need ribbon entries.
    this.addRibbonIcon("sparkles", "Open Companion for Claude", () => void this.activateView());

    this.addCommand({
      id: "open-chat",
      name: "Open chat panel",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "new-chat",
      name: "New chat",
      callback: async () => {
        const view = await this.activateView();
        view?.clearChat();
      },
    });

    this.addCommand({
      id: "plan-from-note",
      name: "Generate implementation plan from current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (checking) return !!file;
        void this.generatePlanFromNote();
        return true;
      },
    });

    this.addCommand({
      id: "artifact-from-selection",
      name: "Turn selection / note into a beautiful artifact",
      callback: () => void this.generateArtifactFromContext(),
    });

    this.addCommand({
      id: "ask-vault",
      name: "Ask Claude about my vault (search-augmented)",
      callback: async () => {
        this.settings.context.searchVault = true;
        await this.saveSettings();
        const view = await this.activateView();
        view?.refreshModelLabel();
        const how = this.settings.semanticEnabled ? "semantic + keyword" : "keyword";
        new Notice(`Vault search is on (${how}) — ask your question in the chat panel.`);
      },
    });

    this.addCommand({
      id: "rebuild-semantic-index",
      name: "Rebuild semantic index (local embeddings)",
      callback: () => void this.rebuildSemanticIndex(),
    });

    this.addCommand({
      id: "open-related-notes",
      name: "Open related notes panel",
      callback: () => void this.activateRelatedView(),
    });

    this.addCommand({
      id: "semantic-index-status",
      name: "Semantic index status",
      callback: () => void this.showSemanticIndexStatus(),
    });

    this.addCommand({
      id: "browse-conversations",
      name: "Resume a past conversation",
      callback: () => void this.browseConversations(),
    });

    this.addCommand({
      id: "delete-active-conversation",
      name: "Delete the current conversation",
      checkCallback: (checking) => {
        const active = this.getActiveConversation();
        if (checking) return !!active;
        void this.deleteActiveConversation();
        return true;
      },
    });

    this.addCommand({
      id: "build-from-plan",
      name: "Hand off current note to Claude Code (build)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (checking) return !!file;
        void this.handoffToBuild();
        return true;
      },
    });

    this.addCommand({
      id: "mark-note-as-plan",
      name: "Mark current note as a plan (adds type: plan + Build icon)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (checking) return file instanceof TFile;
        if (file instanceof TFile) void this.markNoteAsPlan(file);
        return true;
      },
    });

    this.addCommand({
      id: "dispatch-cloud-session",
      name: "Send to cloud Claude session (mobile-friendly)",
      callback: () => void this.dispatchCloudSession(),
    });

    this.addCommand({
      id: "pull-cloud-replies",
      name: "Pull cloud session replies into the vault",
      callback: () => void this.pullCloudReplies(),
    });

    this.addCommand({
      id: "open-workflows",
      name: "Run a vault workflow… (manifests, rollup, MOC, digest)",
      callback: () => void this.openWorkflowPicker(),
    });

    // Session memory reads Claude Code's CLI transcripts off the local
    // filesystem — desktop-only. Skip its commands on mobile.
    if (!Platform.isMobile) {
      this.addCommand({
        id: "capture-session-memory",
        name: "Capture session memory…",
        callback: () => void this.openSessionPicker(),
      });

      this.addCommand({
        id: "open-memory-view",
        name: "Open session memory",
        callback: () => void this.activateMemoryView(),
      });
    }

    this.addSettingTab(new ClaudeCompanionSettingTab(this.app, this));

    // Start the MCP bridge if enabled (deferred so it doesn't block load).
    this.app.workspace.onLayoutReady(() => {
      void this.syncMcpServer();
      this.syncPlanBuildActions();

      // Keep the semantic index fresh as notes change (debounced; no-op when
      // off). Registered AFTER layout-ready so Obsidian's initial vault scan
      // doesn't fire create/modify for every note and stampede the indexer —
      // a full build only happens via the explicit "Rebuild" command.
      this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile && f.extension === "md") this.queueReindex(f.path); }));
      this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile && f.extension === "md") this.queueReindex(f.path); }));
      this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile && f.extension === "md") void this.indexer()?.removeNote(f.path); }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (f instanceof TFile && f.extension === "md") void this.indexer()?.renameNote(oldPath, f.path); }));
    });

    // Show a "Build" action in the header of any `type: plan` note.
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncPlanBuildActions()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncPlanBuildActions()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.syncPlanBuildActions()));
  }

  /** Tracks the Build header-action element we added to each plan-note view. */
  private planBuildActions = new WeakMap<MarkdownView, HTMLElement>();

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
        const action = view.addAction("hammer", "Build this plan with Claude Code", () => void this.handoffToBuild(file ?? undefined));
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

  override onunload(): void {
    void this.mcpServer?.stop();
    this.mcpServer = null;
    if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
  }

  // ---------- settings ----------

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as PersistedData | Partial<PluginSettings> | null;
    // Migrate the legacy shape (data.json *was* the settings object) to the
    // namespaced { settings, conversations } shape.
    const isNamespaced = !!raw && typeof raw === "object" && ("settings" in raw || "conversations" in raw);
    const settingsData = (isNamespaced ? (raw).settings : raw) as Partial<PluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...settingsData,
      context: { ...DEFAULT_SETTINGS.context, ...(settingsData?.context ?? {}) },
    };
    this.convState = isNamespaced
      ? fromPersisted({ conversations: (raw).conversations, activeId: (raw).activeConversationId })
      : emptyState();
  }

  /** Write settings + conversation history back to data.json. */
  private async persist(): Promise<void> {
    const data: PersistedData = {
      settings: this.settings,
      conversations: this.convState.conversations,
      activeConversationId: this.convState.activeId,
    };
    await this.saveData(data);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    // Rebuild providers if any credentials/hosts changed.
    this._router = null;
    // Rebuild the indexer if the embedding model / enabled state changed.
    if (this.indexerModel !== this.settings.embeddingModel || (!this.settings.semanticEnabled && this._indexer)) {
      this.invalidateIndexer();
    }
    this.refreshViews();
    await this.syncMcpServer();
  }

  // ---------- conversation history ----------

  private nextConversationId(): string {
    return `c${Date.now().toString(36)}-${(this.convSeq++).toString(36)}`;
  }

  listConversations(): Conversation[] {
    return this.convState.conversations;
  }

  getActiveConversation(): Conversation | null {
    return getActive(this.convState);
  }

  /**
   * Persist the current message list into the active conversation, creating one
   * on first save. Returns the active conversation id (or null when there is
   * nothing to save). Best-effort: a save failure never blocks the chat.
   */
  async saveActiveConversation(messages: ChatMessage[]): Promise<string | null> {
    if (messages.length === 0) return this.convState.activeId;
    const base = getActive(this.convState) ?? newConversation(this.nextConversationId(), Date.now());
    const updated = touch(base, messages, Date.now());
    this.convState = saveConversation(this.convState, updated, this.settings.maxConversations);
    try {
      await this.persist();
    } catch (e) {
      console.error("[Claude Companion] failed to save conversation", e);
    }
    return updated.id;
  }

  /** Switch the active conversation (e.g. from the history picker). */
  async setActiveConversation(id: string): Promise<Conversation | null> {
    this.convState = setActive(this.convState, id);
    await this.persist();
    return getActive(this.convState);
  }

  /** Start a fresh conversation (the current one is already auto-saved). */
  async startNewConversation(): Promise<void> {
    this.convState = setActive(this.convState, null);
    await this.persist();
  }

  async deleteConversation(id: string): Promise<void> {
    this.convState = removeConversation(this.convState, id);
    await this.persist();
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

  /**
   * Start, stop, or restart the MCP server to match current settings. Serialized
   * (the settings UI calls saveSettings → this on every keystroke, un-awaited)
   * and idempotent (skips a restart when the running server already matches), so
   * overlapping syncs can't EADDRINUSE the fixed port and silently drop the bridge.
   */
  syncMcpServer(): Promise<void> {
    this.mcpSyncChain = this.mcpSyncChain.catch(() => {}).then(() => this.applyMcpServer());
    return this.mcpSyncChain;
  }

  /** The bearer token the server validates against: env var wins over stored. */
  private resolvedMcpToken(): string {
    // eslint-disable-next-line obsidianmd/no-global-this -- Electron/Node global (crypto/process/require), not window-scoped; globalThis works in the node test env and is mobile-safe via optional chaining
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    return resolveMcpToken(env, this.settings.mcpToken).token;
  }

  /** Desired server signature for the current settings, or null when it shouldn't run. */
  private mcpDesiredSignature(): string | null {
    const s = this.settings;
    if (Platform.isMobile || !s.mcpEnabled) return null;
    return JSON.stringify({ port: s.mcpPort, token: this.resolvedMcpToken(), writes: s.mcpAllowWrites, folder: s.mcpWriteFolder });
  }

  private async applyMcpServer(): Promise<void> {
    const desired = this.mcpDesiredSignature();
    // Already running with the same config → nothing to do (avoids churning the
    // port on unrelated settings changes).
    if (desired !== null && this.mcpServer?.isRunning() && desired === this.mcpSignature) return;

    if (this.mcpServer) {
      await this.mcpServer.stop();
      this.mcpServer = null;
      this.mcpSignature = null;
    }
    // The MCP bridge runs only on desktop — it needs a Node http server, which
    // Obsidian's mobile runtime lacks. The dynamic import below keeps that code
    // (and its `http` dependency) from ever loading on mobile.
    if (desired === null) return;

    const s = this.settings;
    const toolOpts = {
      allowWrites: s.mcpAllowWrites,
      defaultFolder: s.mcpWriteFolder,
      semantic: (q: string, k: number) => this.semanticSearch(q, k),
    };
    if (!this.vaultTools) {
      this.vaultTools = new VaultTools(this.app, toolOpts);
    } else {
      this.vaultTools.setOptions(toolOpts);
    }

    const { McpHttpServer } = await import("./mcp/server");
    const server = new McpHttpServer(
      { port: s.mcpPort, token: this.resolvedMcpToken(), serverInfo: { name: "obsidian-vault", version: "0.2.0" } },
      this.vaultTools,
      (level, message) => { if (level === "error") console.error("[Claude Companion MCP]", message); },
    );
    try {
      await server.start();
      this.mcpServer = server;
      this.mcpSignature = desired;
    } catch (e) {
      new Notice(`MCP bridge failed to start on port ${s.mcpPort}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  mcpRunning(): boolean {
    return this.mcpServer?.isRunning() ?? false;
  }

  mcpStats(): { running: boolean; port: number | null; activeRequests: number; handledRequests: number } {
    const stats = this.mcpServer?.stats() ?? { activeRequests: 0, handledRequests: 0 };
    return {
      running: this.mcpRunning(),
      port: this.mcpServer?.address()?.port ?? null,
      activeRequests: stats.activeRequests,
      handledRequests: stats.handledRequests,
    };
  }

  async setMcpEnabled(enabled: boolean): Promise<void> {
    this.settings.mcpEnabled = enabled;
    // Only mint a stored token when neither the env var nor a stored token exists.
    if (enabled && !this.resolvedMcpToken()) {
      this.settings.mcpToken = generateToken();
    }
    await this.saveSettings();
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
  }

  // ---------- providers ----------

  router(): ProviderRouter {
    if (!this._router) this._router = new ProviderRouter(this.settings);
    return this._router;
  }

  composeSystemPrompt(): string {
    return `${this.settings.systemPrompt}\n\n${DESIGN_SYSTEM_PROMPT}`;
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

  /** Absolute-ish vault-relative path to the persisted index, in the plugin dir. */
  private indexPath(): string {
    return `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/semantic-index.json`;
  }

  /**
   * The live semantic indexer, or null when semantic search is off. Rebuilds the
   * instance if the embedding model changed. IO is wired here; logic is pure.
   */
  indexer(): SemanticIndexer | null {
    if (!this.settings.semanticEnabled) return null;
    const model = this.settings.embeddingModel;
    if (this._indexer && this.indexerModel === model) return this._indexer;

    const adapter = this.app.vault.adapter;
    const path = this.indexPath();
    this._indexer = new SemanticIndexer({
      embeddingModel: model,
      listMarkdown: (): IndexFile[] =>
        this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime })),
      read: async (p: string) => {
        const f = this.app.vault.getAbstractFileByPath(p);
        return f instanceof TFile ? this.app.vault.cachedRead(f) : "";
      },
      embed: (input: string[]) => this.router().ollama.embed(model, input),
      load: async () => {
        try {
          if (await adapter.exists(path)) return JSON.parse(await adapter.read(path)) as IndexData;
        } catch {
          /* corrupt/missing → rebuild from empty */
        }
        return null;
      },
      save: async (data: IndexData) => {
        await adapter.write(path, JSON.stringify(data));
      },
    });
    this.indexerModel = model;
    return this._indexer;
  }

  /** Drop the cached indexer (after the embedding model / enabled state changes). */
  invalidateIndexer(): void {
    this._indexer = null;
    this.indexerModel = null;
  }

  /** Semantic retriever for chat grounding. Returns [] when off or unavailable. */
  async semanticSearch(query: string, k: number): Promise<{ path: string; text: string }[]> {
    const ix = this.indexer();
    if (!ix) return [];
    try {
      const hits = await ix.search(query, k);
      return hits.map((h) => ({ path: h.path, text: h.text }));
    } catch {
      return []; // Ollama down / model missing → keyword-only, no regression
    }
  }

  /** Notes related to a given note (for the Related Notes panel). [] when off. */
  async relatedNotes(path: string, k: number): Promise<{ path: string; score: number }[]> {
    const ix = this.indexer();
    if (!ix) return [];
    const hits = await ix.related(path, k);
    return hits.map((h) => ({ path: h.path, score: h.score }));
  }

  /** Full (re)build of the semantic index, with a progress toast. */
  async rebuildSemanticIndex(): Promise<void> {
    if (!this.settings.semanticEnabled) {
      new Notice("Turn on semantic search in Companion settings first.");
      return;
    }
    if (!this.router().ollama.hasCredentials()) {
      new Notice("Semantic search needs Ollama. Start it (`ollama serve`) or set the host in settings.");
      return;
    }
    const ix = this.indexer();
    if (!ix) return;
    const progress = new Notice(`Building semantic index with “${this.settings.embeddingModel}”…`, 0);
    try {
      const res = await ix.build({
        force: true,
        onProgress: (done, total) => progress.setMessage(`Semantic index: ${done}/${total} notes…`),
      });
      progress.hide();
      new Notice(`Semantic index ready — ${res.indexed} embedded, ${res.skipped} skipped, ${res.removed} pruned.`, 6000);
    } catch (e) {
      progress.hide();
      console.error("[Claude Companion] semantic index build failed", e);
      new Notice(`Semantic index failed: ${e instanceof Error ? e.message : String(e)}`, 9000);
    }
  }

  /** Report the semantic index state in a Notice (on/off · counts · model · reach). */
  async showSemanticIndexStatus(): Promise<void> {
    if (!this.settings.semanticEnabled) {
      new Notice("Semantic search is off — turn it on in Companion settings to index your vault.", 7000);
      return;
    }
    const ix = this.indexer();
    if (!ix) {
      new Notice("Semantic index is unavailable.", 6000);
      return;
    }
    try {
      const [{ notes, chunks }, localOk] = await Promise.all([ix.stats(), this.router().localAvailable()]);
      const reach = localOk ? "Ollama reachable" : "Ollama unreachable — searches fall back to keyword";
      new Notice(`Semantic index · ${notes} notes, ${chunks} chunks · “${this.settings.embeddingModel}” · ${reach}`, 9000);
    } catch (e) {
      new Notice(`Semantic index status unavailable: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  /** Queue a single note for incremental re-embed (debounced ~1.5s). */
  private queueReindex(path: string): void {
    if (!this.settings.semanticEnabled) return;
    this.reindexQueue.add(path);
    if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
    this.reindexTimer = window.setTimeout(() => void this.flushReindex(), 1500);
  }

  private async flushReindex(): Promise<void> {
    this.reindexTimer = null;
    const ix = this.indexer();
    if (!ix) {
      this.reindexQueue.clear();
      return;
    }
    const paths = Array.from(this.reindexQueue);
    this.reindexQueue.clear();
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) {
        try {
          await ix.updateNote(p, f.stat.mtime);
        } catch {
          /* transient embed failure — picked up on next change or rebuild */
        }
      }
    }
  }

  // ---------- view ----------

  async activateView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    if (leaf) {
      await workspace.revealLeaf(leaf);
      return leaf.view instanceof ChatView ? leaf.view : null;
    }
    return null;
  }

  // ---------- session memory ----------

  /** Absolute path of the current vault, or null if not a desktop file vault. */
  private vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /** List this vault's Claude Code sessions (newest first). Desktop-only. */
  async listVaultSessions(): Promise<SessionMeta[]> {
    const base = this.vaultBasePath();
    if (!base || Platform.isMobile) return [];
    // node fs reader lives in the desktop-only module — load it lazily.
    const { nodeSessionReader, defaultProjectsRoot } = await import("./memory/nodeReader");
    return listSessionsForVault(nodeSessionReader, base, defaultProjectsRoot());
  }

  private ingestDeps() {
    return {
      app: this.app,
      read: async (path: string) => {
        const { nodeSessionReader } = await import("./memory/nodeReader");
        return nodeSessionReader.read(path);
      },
      folder: this.settings.memoryFolder,
      baseTags: this.settings.memoryBaseTags,
    };
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

  /** Open the picker; ingest the chosen session. */
  async openSessionPicker(): Promise<void> {
    if (!this.settings.memoryEnabled) {
      new Notice("Session memory is disabled in settings.");
      return;
    }
    const sessions = await this.listVaultSessions();
    if (sessions.length === 0) {
      new Notice(
        "No Claude Code sessions found for this vault. Run the `claude` CLI from this vault's folder, then capture.",
        8000,
      );
      return;
    }
    new SessionPicker(this.app, sessions, (session) => {
      void this.captureSession(session);
    }).open();
  }

  /** Ingest one session and report. */
  async captureSession(session: SessionMeta): Promise<void> {
    try {
      const res = await ingestSession(this.ingestDeps(), { id: session.id, path: session.path });
      new Notice(`Captured session · ${res.redactions} secret${res.redactions === 1 ? "" : "s"} redacted`);
      await this.refreshMemoryView();
      await this.app.workspace.getLeaf(false).openFile(res.file);
    } catch (e) {
      console.error("[Claude Companion] session capture failed", e);
      new Notice("Session capture failed — see console.");
    }
  }

  /** Capture the most-recent CLI session for this vault. */
  async captureLatestSession(): Promise<void> {
    const sessions = await this.listVaultSessions();
    if (sessions.length === 0) {
      new Notice("No Claude Code session found for this vault to ingest.");
      return;
    }
    const latest = sessions[0];
    if (!latest) return;
    await this.captureSession(latest);
  }

  /**
   * Capture the current in-app conversation into memory (adapter B). Idempotent
   * by conversation id, so re-saving updates the same digest note. Best-effort.
   */
  async captureConversation(messages: ChatMessage[]): Promise<void> {
    if (!this.settings.memoryEnabled || messages.length === 0) return;
    const conv = this.getActiveConversation();
    try {
      const meta = {
        ...(conv?.id !== undefined ? { sessionId: conv.id } : {}),
        model: this.settings.model,
        ...(conv ? { startedAt: new Date(conv.createdAt).toISOString(), endedAt: new Date(conv.updatedAt).toISOString() } : {}),
      };
      const res = await ingestConversation(
        { app: this.app, folder: this.settings.memoryFolder, baseTags: this.settings.memoryBaseTags },
        messages,
        meta,
      );
      new Notice(`Conversation captured to memory · ${res.redactions} secret${res.redactions === 1 ? "" : "s"} redacted`);
      await this.refreshMemoryView();
    } catch (e) {
      console.error("[Claude Companion] conversation capture failed", e);
      new Notice("Couldn't capture this conversation to memory — see console.");
    }
  }

  /** Re-ingest by session id (called from the sidebar). */
  async reingestSession(sessionId: string): Promise<void> {
    const sessions = await this.listVaultSessions();
    const match = sessions.find((s) => (s.sessionId ?? s.id) === sessionId);
    if (!match) {
      new Notice("Original session transcript not found on disk.");
      return;
    }
    await this.captureSession(match);
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
   * Turn the active note (an implementation plan) into a build spec + a live
   * tracker note, then hand it to Claude Code. Claude Code reaches the vault
   * through the MCP bridge and updates the tracker as it builds.
   */
  async handoffToBuild(planFile?: TFile): Promise<void> {
    const file = planFile ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    if (!(file instanceof TFile)) {
      new Notice("Open a plan note first — a note with a task checklist (`- [ ]`) or numbered milestones.", 8000);
      return;
    }
    const plan = await this.app.vault.cachedRead(file);
    const tasks = extractTasks(plan);
    // A "plan note" is one we can extract work items from. If we can't, don't
    // dispatch a hollow build — tell the user exactly what's missing.
    if (tasks.length === 0) {
      new Notice(
        `“${file.basename}” doesn't look like a plan — no task checklist (\`- [ ]\`) or numbered milestones found. ` +
          `Run “Generate implementation plan” first, or add tasks, then build.`,
        9000,
      );
      return;
    }

    const title = file.basename;
    const folder = this.settings.mcpWriteFolder || "Claude/Builds";

    // Confirm before dispatch — this writes notes and copies a command to run.
    const confirmed = await new Promise<boolean>((resolve) => {
      new ConfirmModal(this.app, {
        title: "Build from this plan?",
        body:
          `Detected ${tasks.length} task${tasks.length === 1 ? "" : "s"} in “${file.basename}”.\n\n` +
          `This creates a build spec + a live tracker in “${folder}” and copies a Claude Code command for you to run in a terminal.`,
        cta: "Create spec + tracker",
        onResolve: resolve,
      }).open();
    });
    if (!confirmed) return;

    await this.ensureFolder(folder);
    const specPath = normalizePath(`${folder}/${title} — spec.md`);
    const trackerPath = normalizePath(`${folder}/${title} — tracker.md`);

    const input: SpecInput = { title, plan, specPath, trackerPath, tasks, vault: this.app.vault.getName() };

    // Spec note.
    const specFm = buildFrontmatter({ title: `${title} — spec`, created: new Date().toISOString().slice(0, 10), source: "claude-companion", type: "build-spec", tags: normalizeTags(["claude", "build", "spec"]) });
    await this.writeOrReplace(specPath, `${specFm}\n\n${specBody(input)}`);

    // Tracker note (an updating claude-html artifact + a checklist Claude Code appends to).
    const trackerFm = buildFrontmatter({ title: `${title} — tracker`, created: new Date().toISOString().slice(0, 10), source: "claude-companion", type: "build-tracker", tags: normalizeTags(["claude", "build", "tracker"]) });
    const trackerBody = [trackerFm, "", `# ${title} — build tracker`, "", "```claude-html height=520", trackerArtifact(title, tasks), "```", "", "## Progress log", "", "<!-- Claude Code appends progress here -->", ""].join("\n");
    const trackerFile = await this.writeOrReplace(trackerPath, trackerBody);

    // Hand off: copy the ready-to-run command, open the tracker.
    const command = claudeCodeBuildCommand(input);
    await navigator.clipboard.writeText(command).catch(() => {});
    await this.app.workspace.getLeaf(true).openFile(trackerFile);

    new Notice("Build spec + tracker created. Claude Code command copied — run it in a terminal (requires the official Obsidian CLI).", 8000);
  }

  private async ensureFolder(folder: string): Promise<void> {
    const p = normalizePath(folder);
    if (p === "" || p === "/" || this.app.vault.getAbstractFileByPath(p)) return;
    let cur = "";
    for (const part of p.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          /* race */
        }
      }
    }
  }

  private async writeOrReplace(path: string, content: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    return this.app.vault.create(path, content);
  }

  // ---------- cloud session dispatch ----------

  private cloudConfig(): CloudDispatchConfig {
    return {
      fireUrl: this.settings.cloudRoutineFireUrl,
      token: this.settings.cloudRoutineToken,
      betaHeader: this.settings.cloudRoutineBetaHeader,
    };
  }

  /**
   * Prompt for what a cloud session should do, attach light vault context
   * (active note path + selection), and fire the configured routine. Desktop
   * first (Phase 1) — de-risks the Routines API ahead of the mobile build.
   */
  async dispatchCloudSession(): Promise<void> {
    if (!this.settings.cloudDispatchEnabled) {
      new Notice("Cloud session dispatch is off. Enable it in Companion settings → Cloud session.", 7000);
      return;
    }
    const cfgErr = configError(this.cloudConfig());
    if (cfgErr) {
      new Notice(`Cloud session not configured: ${cfgErr}`, 9000);
      return;
    }
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = mdView?.editor.getSelection().trim() ?? "";
    const parts: string[] = [];
    if (mdView?.file) parts.push(`Active note: ${mdView.file.path}`);
    if (selection) parts.push(`Selected text:\n${selection}`);
    const context = parts.length ? parts.join("\n\n") : undefined;

    new CloudDispatchModal(this.app, context, (instruction) => void this.fireCloudSession(instruction, context)).open();
  }

  private async fireCloudSession(instruction: string, context?: string): Promise<void> {
    const pending = new Notice("Dispatching cloud session…", 0);
    try {
      const req = buildFireRequest(this.cloudConfig(), composeDispatchText(instruction, context));
      const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
      const result = parseFireResponse(res.status, res.text);
      pending.hide();
      if (result.sessionUrl) {
        await navigator.clipboard.writeText(result.sessionUrl).catch(() => {});
        new Notice(`Cloud session started — link copied to clipboard:\n${result.sessionUrl}`, 12000);
      } else {
        new Notice("Cloud session fired. (No session link was returned.)", 8000);
      }
    } catch (e) {
      pending.hide();
      new Notice(`Cloud dispatch failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
  }

  private replyConfig(): RepliesConfig {
    return {
      repo: this.settings.cloudReplyRepo,
      branch: this.settings.cloudReplyBranch,
      folder: this.settings.cloudReplyFolder,
      token: this.settings.cloudReplyToken,
    };
  }

  /**
   * Fetch reply notes a cloud session wrote into the vault's GitHub repo and
   * land any new ones in the vault — over HTTPS, so it works on mobile. Existing
   * notes are left untouched (never clobbers local edits).
   */
  async pullCloudReplies(): Promise<void> {
    const cfg = this.replyConfig();
    const cfgErr = repliesConfigError(cfg);
    if (cfgErr) {
      new Notice(`Cloud replies not configured: ${cfgErr}`, 9000);
      return;
    }
    const pending = new Notice("Checking for cloud replies…", 0);
    try {
      const list = buildContentsRequest(cfg, cfg.folder);
      const listRes = await requestUrl({ url: list.url, method: list.method, headers: list.headers, throw: false });
      const files = parseDirListing(listRes.status, listRes.text).filter((f) => isMarkdown(f.name));
      let pulled = 0;
      for (const f of files) {
        if (this.app.vault.getAbstractFileByPath(normalizePath(f.path))) continue; // don't clobber local notes
        const fileReq = buildContentsRequest(cfg, f.path);
        const fileRes = await requestUrl({ url: fileReq.url, method: fileReq.method, headers: fileReq.headers, throw: false });
        const got = parseFileResponse(fileRes.status, fileRes.text);
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
        if (dir) await this.ensureFolder(dir);
        await this.app.vault.create(normalizePath(f.path), got.text);
        pulled++;
      }
      pending.hide();
      new Notice(pulled > 0 ? `Pulled ${pulled} cloud repl${pulled === 1 ? "y" : "ies"} into the vault.` : "No new cloud replies.", 7000);
    } catch (e) {
      pending.hide();
      new Notice(`Couldn't pull cloud replies: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
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

/** A simple confirm/cancel dialog that resolves a boolean. */
class ConfirmModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private opts: { title: string; body: string; cta: string; onResolve: (ok: boolean) => void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.opts.title);
    const p = this.contentEl.createEl("p", { cls: "setting-item-description" });
    p.setCssStyles({ whiteSpace: "pre-wrap" });
    p.setText(this.opts.body);
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const ok = row.createEl("button", { cls: "mod-cta", text: this.opts.cta });
    ok.addEventListener("click", () => {
      this.decided = true;
      this.opts.onResolve(true);
      this.close();
    });
  }

  override onClose(): void {
    if (!this.decided) this.opts.onResolve(false);
  }
}

/** Minimal prompt for what a dispatched cloud session should do. */
class CloudDispatchModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private context: string | undefined,
    private onSubmit: (instruction: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Send to cloud Claude session" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Fires your Claude Code routine in the cloud against your vault's repo. What should it do?",
    });
    if (this.context) {
      contentEl.createEl("p", { cls: "setting-item-description", text: `Attaching — ${this.context.split("\n")[0]}` });
    }

    const ta = contentEl.createEl("textarea");
    ta.rows = 5;
    ta.setCssStyles({ width: "100%" });
    ta.placeholder = "e.g. Summarize this week's meeting notes into a decisions log and open a PR.";
    ta.addEventListener("input", () => (this.value = ta.value));
    window.setTimeout(() => ta.focus(), 0);

    const controls = contentEl.createDiv({ cls: "modal-button-container" });
    const send = controls.createEl("button", { text: "Dispatch", cls: "mod-cta" });
    send.addEventListener("click", () => {
      const v = this.value.trim();
      if (!v) {
        new Notice("Type what the cloud session should do.");
        return;
      }
      this.close();
      this.onSubmit(v);
    });
    controls.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
