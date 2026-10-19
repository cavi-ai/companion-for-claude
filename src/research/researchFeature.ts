// Research Desk, scholarly discovery, and the plan-to-build handoff: view
// construction, the discovery coordinators, refresh scheduling, and the
// plan-note Build action.

import { MarkdownView, normalizePath, Notice, requestUrl, TFile, type App, type WorkspaceLeaf } from "obsidian";
import type { ActivityStore } from "../activity/store";
import { PLANNING_INSTRUCTION } from "../artifacts/designSystem";
import { beginActivity } from "../activity/progress";
import type { BuildController } from "../build/controller";
import type { BuildRun } from "../build/run";
import { resolveModelId } from "../claude/models";
import { ArxivAdapter } from "../discovery/adapters/arxiv";
import { CrossrefAdapter } from "../discovery/adapters/crossref";
import { createObsidianDiscoveryHttp } from "../discovery/adapters/obsidianHttp";
import { OpenAlexAdapter } from "../discovery/adapters/openAlex";
import { DiscoveryCoordinator } from "../discovery/coordinator";
import { DISCOVERY_CACHE_HOURS, DISCOVERY_EXPANSION_LIMIT, DISCOVERY_MAX_RESULTS } from "../discovery/limits";
import { REWRITE_SYSTEM, buildGroundedRewriteUser, buildRewriteUser, parseRewrite, rewriteMaxTokens } from "../edit/rewrite";
import { summarizeAndTag } from "../indexing/autoTagger";
import { noteExcerpt } from "../markdown/excerpt";
import { stripFrontmatter } from "../markdown/frontmatter";
import type { ProviderRouter } from "../providers/router";
import type { Provider } from "../providers/types";
import { extractPdfPages } from "../semantic/pdf";
import { parseClipUrl } from "../sources/detect";
import { vaultVocabulary } from "../tags/vaultTags";
import type { PluginSettings } from "../types";
import { ensureVaultFolder } from "../vault/vaultFiles";
import type { ChatView } from "../view/ChatView";
import { BuildView, BUILD_VIEW_TYPE } from "../view/BuildView";
import type { CompanionChromeDependencies } from "../view/companionChrome";
import { ResearchView, RESEARCH_DESK_VIEW_TYPE } from "../view/ResearchView";
import { DiscoveryModal } from "../view/research/discoveryModal";
import { ResearchActions } from "../view/research/actions";
import { ProjectCreateModal } from "../view/research/projectCreateModal";
import { ProjectSourceRecoveryModal } from "../view/research/projectSourceRecoveryModal";
import { QUESTION_INSTRUCTION } from "../view/research/shared";
import { DraftCoordinator } from "./draftCoordinator";
import { resolveSourceText } from "./evidenceExtraction";
import type { ProjectSnapshot } from "./graph";
import { ResearchRepository } from "./repository";
import { createResearchRepository } from "./repositoryFactory";
import { researchCoordinatorMode, researchModelChip } from "./researchModel";
import { RevisionCoordinator } from "./revisionCoordinator";
import { captureWebSource } from "./webCapture";
import { inferResearchProjectPath, projectPathForActivation } from "./workbenchRouting";

export interface ResearchFeatureDeps {
  app: App;
  settings: () => PluginSettings;
  activity: () => ActivityStore;
  router: () => ProviderRouter;
  build: () => BuildController;
  activateView: () => Promise<ChatView | null>;
  lastMarkdownFile: () => TFile | null;
  companionChrome: () => CompanionChromeDependencies;
  openCompanionSettings: () => void;
  artifactMaxTokens: number;
}

export class ResearchFeature {
  /** Tracks the Build header-action element we added to each plan-note view. */
  private planBuildActions = new WeakMap<MarkdownView, HTMLElement>();
  /** Debounces research-only metadata changes without reacting to unrelated vault notes. */
  private researchRefreshTimer: number | null = null;
  private researchRefreshChanges: Array<{ path: string; oldPath?: string }> = [];
  private _discoveryCoordinator: DiscoveryCoordinator | null = null;
  private _viewDiscoveryCoordinators?: Set<DiscoveryCoordinator>;

  constructor(private deps: ResearchFeatureDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Cancels discovery work and the pending research refresh. */
  dispose(): void {
    this._discoveryCoordinator?.cancel();
    this._discoveryCoordinator?.clearCache();
    this._discoveryCoordinator = null;
    for (const coordinator of this._viewDiscoveryCoordinators ?? []) { coordinator.cancel(); coordinator.clearCache(); }
    this._viewDiscoveryCoordinators?.clear();
    if (this.researchRefreshTimer !== null) window.clearTimeout(this.researchRefreshTimer);
  }

  /** The Research Desk view with the dependencies it needs. */
  createDeskView(leaf: WorkspaceLeaf): ResearchView {
    return new ResearchView(leaf, this.researchRepository(), {
      chrome: this.deps.companionChrome(),
      actions: this.createResearchActions(),
      askResearch: (projectPath, prompt, display) => this.askResearch(projectPath, prompt, display),
      openPath: (path) => this.openResearchPath(path),
      webSearchEnabled: () => this.settings.webSearchEnabled,
      draftCoordinator: new DraftCoordinator({ selection: () => this.requireResearchSelection(), maxTokens: () => this.settings.maxTokens }),
      revisionCoordinator: new RevisionCoordinator({ selection: () => this.requireResearchSelection(), maxTokens: () => this.settings.maxTokens }),
      openDiscovery: (snapshot) => this.openDiscovery(snapshot),
      startFromActiveNote: () => void this.startResearchFromActiveNote(),
      researchStatus: () => this.deps.router().researchStatus(),
      openResearchSettings: () => this.deps.openCompanionSettings(),
    });
  }

  /**
   * Add (or remove) a "Build" icon in the header of every open markdown note that
   * declares `type: plan` in frontmatter, wired to build that specific note. A
   * note becomes "canonical" by carrying `type: plan`.
   */
  syncPlanBuildActions(): void {
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

  /** One step runner shared by the Research Desk and Workbench. */
  private createResearchActions(): ResearchActions {
    return new ResearchActions({
      app: this.app,
      repository: this.researchRepository(),
      rewriteText: this.researchRewriteText(),
      completeResearch: async ({ system, user, maxTokens }) => (await this.deps.router().completeResolved(this.requireResearchSelection(), { system, user, maxTokens: maxTokens ?? 1024, temperature: 0.2 })).text,
      researchLabel: () => researchModelChip(this.deps.router().researchStatus()).text.replace(/^AI · /, ""),
      sourceText: (source) => resolveSourceText(source, {
        readPdfPages: async (assetPath) => {
          const file = this.app.vault.getAbstractFileByPath(assetPath);
          if (!(file instanceof TFile)) return null;
          const { loadPdf } = await import("../semantic/pdfjs");
          return extractPdfPages(loadPdf, await this.app.vault.readBinary(file));
        },
        readNote: async (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          return file instanceof TFile ? this.app.vault.cachedRead(file) : null;
        },
      }),
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
          const { tags } = await summarizeAndTag(this.deps.router(), content, vaultVocabulary(this.app));
          return tags;
        } catch (e) {
          console.warn("[companion] source tagging failed", e);
          return [];
        }
      },
      openPath: (path) => this.openResearchPath(path),
      changed: () => this.refreshResearchViews(),
      selectProject: async (path) => {
        for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_DESK_VIEW_TYPE)) if (leaf.view instanceof ResearchView) await leaf.view.setProjectPath(path);
      },
    });
  }

  private async openResearchPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Research note not found: ${path}`);
  }

  async askResearch(projectPath: string, prompt: string, display: string): Promise<boolean> {
    const view = await this.deps.activateView();
    if (!view) return false;
    view.attachNote(projectPath);
    return view.submitPrompt(prompt, display);
  }

  private openDiscovery(snapshot: ProjectSnapshot): void {
    const coordinator = this.createDiscoveryCoordinator();
    new DiscoveryModal(this.app, coordinator, snapshot, () => this.researchRepository().loadProject(snapshot.project.path), (path) => this.openResearchPath(path), () => this.releaseDiscoveryCoordinator(coordinator)).open();
  }

  private async refreshResearchViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_DESK_VIEW_TYPE)) if (leaf.view instanceof ResearchView) await leaf.view.render();
  }

  private requireResearchSelection(): { provider: Provider; model: string } {
    const selection = this.deps.router().researchSelection();
    if (!selection) throw new Error("Research AI is off. Turn it on in Settings → Research Desk & discovery.");
    return selection;
  }

  /** Shared chat-free rewrite helper for the research surfaces (claims, evidence, project questions). */
  private researchRewriteText(): (input: { text: string; instruction: string; context?: string }) => Promise<string> {
    return async ({ text, instruction, context }) => {
      const { text: raw } = await this.deps.router().completeResolved(this.requireResearchSelection(), {
        system: REWRITE_SYSTEM,
        user: context ? buildGroundedRewriteUser(text, instruction, context) : buildRewriteUser(text, instruction),
        maxTokens: rewriteMaxTokens(text),
        temperature: 0.3,
      });
      return parseRewrite(raw, text);
    };
  }

  /**
   * Seed a research project from the open note: pre-draft a sharp question
   * grounded in the note, confirm via the create-project modal, import the
   * note as the first source, then land on Discover so the preliminary
   * scholarly search is one click away.
   */
  async startResearchFromActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.deps.lastMarkdownFile();
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
    const drafting = beginActivity(this.deps.activity(), "Drafting a research question from the note…");
    try {
      question = await this.researchRewriteText()({ text: file.basename, instruction: QUESTION_INSTRUCTION, context: noteExcerpt(content, 3000) });
    } catch (e) {
      drafting.fail(e);
      console.warn("[companion] question drafting failed", e);
    } finally {
      drafting.finish();
    }
    new ProjectCreateModal(this.app, async (input) => {
      const record = await this.researchRepository().createProject(input);
      const url = parseClipUrl(content);
      const body = stripFrontmatter(content).trim();
      const sourceInput = {
        title: file.basename,
        sourceKind: "vault" as const,
        ...(url ? { url } : {}),
        capturedContent: body.slice(0, 50000),
      };
      const addSource = async () => { await this.researchRepository().importSource(record.path, sourceInput); };
      try {
        await addSource();
      } catch (cause) {
        new ProjectSourceRecoveryModal(this.app, {
          projectPath: record.path,
          sourceTitle: file.basename,
          cause,
          retry: addSource,
          openProject: () => this.activateResearchDesk(record.path),
        }).open();
        return;
      }
      new Notice(`Project started with “${file.basename}” as the first source.`);
      await this.activateResearchDesk(record.path);
    }, this.researchRewriteText(), { title: file.basename, folder: `Research/${file.basename}`, ...(question ? { question } : {}) }).open();
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
          maxResults: DISCOVERY_MAX_RESULTS,
          ...(this.settings.openAlexContactEmail.trim() ? { contact: this.settings.openAlexContactEmail.trim() } : {}),
        }).search(query, cursor, signal),
      expand: (input: Parameters<OpenAlexAdapter["expand"]>[0], signal?: AbortSignal) =>
        new OpenAlexAdapter(http, {
          maxResults: DISCOVERY_EXPANSION_LIMIT,
          ...(this.settings.openAlexContactEmail.trim() ? { contact: this.settings.openAlexContactEmail.trim() } : {}),
        }).expand(input, signal),
    };
    return new DiscoveryCoordinator({
      openAlex,
      crossref: new CrossrefAdapter(http),
      arxiv: new ArxivAdapter(http),
      repository: this.researchRepository(),
      enabled: () => this.settings.discoveryEnabled,
      cacheHours: () => DISCOVERY_CACHE_HOURS,
      rerankerMode: () => researchCoordinatorMode(this.settings.researchModel),
      chatBackend: () => this.settings.chatBackend,
      anthropic: () => ({ provider: this.deps.router().anthropic, model: resolveModelId(this.settings.model, this.settings.customModel) }),
      local: () => ({ provider: this.deps.router().ollama, model: this.settings.ollamaModel }),
      chat: () => this.deps.router().chatProvider(),
      localAvailable: () => this.deps.router().localAvailable(),
    });
  }

  clearDiscoveryCache(): void {
    this._discoveryCoordinator?.clearCache();
    for (const coordinator of this._viewDiscoveryCoordinators ?? []) coordinator.clearCache();
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
    if (leaf?.view instanceof ResearchView) {
      const selected = leaf.view.getProjectPath();
      const next = projectPathForActivation(projectPath, inferred, selected);
      if (next && next !== selected) await leaf.view.setProjectPath(next);
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  scheduleResearchRefresh(path: string, oldPath?: string): void {
    this.researchRefreshChanges.push({ path, ...(oldPath ? { oldPath } : {}) });
    if (this.researchRefreshTimer !== null) window.clearTimeout(this.researchRefreshTimer);
    this.researchRefreshTimer = window.setTimeout(() => {
      this.researchRefreshTimer = null;
      const changes = this.researchRefreshChanges;
      this.researchRefreshChanges = [];
      for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_DESK_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof ResearchView && changes.some(({ path, oldPath }) => view.isRelevantChange(path, oldPath))) void view.render();
      }
    }, 250);
  }

  researchRepository(): ResearchRepository {
    return createResearchRepository(this.app, {
      ensureFolder: (folder) => ensureVaultFolder(this.app, folder),
      includeBinary: true,
    });
  }

  async generatePlanFromNote(): Promise<void> {
    const view = await this.deps.activateView();
    if (!view) return;
    await view.submitPrompt(
      `${PLANNING_INSTRUCTION}\n\nBase the plan entirely on the content of my current note.`,
      "Generate an implementation plan from this note",
      this.deps.artifactMaxTokens,
      { context: { activeNote: true } },
    );
  }

  async handoffToBuild(planFile?: TFile): Promise<void> {
    const file = planFile ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    const runId = await this.deps.build().handoffToBuild(
      file instanceof TFile ? { path: file.path, basename: file.basename } : null,
    );
    if (runId) await this.activateBuildView(runId);
  }

  activeBuildRun(): BuildRun | null {
    return this.deps.build().activeBuildRun();
  }

  async activateBuildView(runId?: string): Promise<BuildView | null> {
    if (runId) await this.deps.build().selectActiveRun(runId);
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
}
