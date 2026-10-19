// Opens and reuses Companion's workspace leaves, resolves the active-note card,
// runs chat-driven workflows, and keeps the Source inbox ribbon badge current.

import { MarkdownView, Notice, Platform, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { auditProject } from "../research/audit";
import { nextSteps } from "../research/nextSteps";
import { documentSections } from "../research/sectionStatus";
import { deriveResearchStage } from "../research/stage";
import { inferResearchProjectPath } from "../research/workbenchRouting";
import type { ResearchFeature } from "../research/researchFeature";
import type { OrdersFeature } from "../orders/ordersFeature";
import type { SourceEnrichmentController, EnrichRunOutcome } from "../sources/controller";
import { inboxItems } from "../sources/inbox";
import type { PluginSettings } from "../types";
import { WORKFLOWS, type Workflow } from "../workflows/catalog";
import { ChatView, CHAT_VIEW_TYPE } from "./ChatView";
import { InboxView, INBOX_VIEW_TYPE } from "./InboxView";
import { MemoryView, MEMORY_VIEW_TYPE } from "./MemoryView";
import { RELATED_VIEW_TYPE } from "./RelatedView";
import { SYSTEM_VIEW_TYPE } from "./SystemView";
import { WorkflowPicker } from "./WorkflowPicker";
import { resolveCompanionWorkspace, type CompanionWorkspaceCard } from "./companionWorkspace";
import { saveEditedNote } from "./saveEditedNote";

/** Output-token ceiling for artifact-producing flows (plans, artifacts, workflows),
 *  which routinely run past the chat default. A ceiling, not a target — you only
 *  pay for what's generated. Within current models' max-output limits. */
// Artifacts/plans are long (rich layout + inline script); give generous output
// headroom so a tabbed document finishes instead of truncating into broken JS.
export const ARTIFACT_MAX_TOKENS = 32000;

export interface WorkspaceViewsDeps {
  app: App;
  settings: () => PluginSettings;
  research: () => ResearchFeature;
  orders: () => OrdersFeature;
  enrichment: () => SourceEnrichmentController;
}

export class WorkspaceViews {
  /** Most recently focused Chat leaf, for activateView()'s desktop reuse preference. */
  lastFocusedChatLeaf: WorkspaceLeaf | null = null;
  /** Source-inbox ribbon icon + its pending-count badge (debounced). */
  private inboxRibbonEl: HTMLElement | null = null;
  private inboxBadgeTimer: number | null = null;

  constructor(private deps: WorkspaceViewsDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Cancels a pending badge refresh. */
  dispose(): void {
    if (this.inboxBadgeTimer !== null) window.clearTimeout(this.inboxBadgeTimer);
  }

  setInboxRibbon(el: HTMLElement): void {
    this.inboxRibbonEl = el;
  }

  async activateView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null;
    if (Platform.isMobile) {
      // Mobile's right split is a drawer, not the full-width main workspace.
      // Reuse only a Chat leaf outside that drawer so repeated activation keeps
      // the same conversation without accumulating duplicate main tabs.
      const rightSplit = workspace.rightSplit;
      const candidates = workspace.getLeavesOfType(CHAT_VIEW_TYPE).filter((candidate) => {
        let parent: unknown = candidate.parent;
        while (parent) {
          if (parent === rightSplit) return false;
          parent = (parent as { parent?: unknown }).parent;
        }
        return true;
      });
      const preferred = this.lastFocusedChatLeaf && candidates.includes(this.lastFocusedChatLeaf) ? this.lastFocusedChatLeaf : null;
      leaf = preferred ?? candidates[0] ?? null;
      if (!leaf) {
        leaf = workspace.getLeaf("tab");
        await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      }
    } else {
      const chatLeaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
      const preferred = this.lastFocusedChatLeaf && chatLeaves.includes(this.lastFocusedChatLeaf) ? this.lastFocusedChatLeaf : null;
      leaf = preferred ?? chatLeaves[0] ?? null;
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

  /** Open a fresh, empty Chat tab alongside any others (desktop and mobile alike). */
  async openNewChatTab(): Promise<ChatView | null> {
    const { workspace } = this.app;
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true, state: { conversationId: null } });
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  async companionWorkspaceContext(): Promise<CompanionWorkspaceCard | null> {
    const active = this.app.workspace.getActiveFile();
    if (!(active instanceof TFile) || active.extension !== "md") return null;
    const frontmatter = this.app.metadataCache.getFileCache(active)?.frontmatter as Record<string, unknown> | undefined;
    const projectPath = inferResearchProjectPath(active.path, frontmatter);
    if (projectPath) {
      try {
        const snapshot = await this.deps.research().researchRepository().loadProject(projectPath);
        const audit = auditProject(snapshot);
        const document = await documentSections(snapshot, (path) => this.deps.research().researchRepository().loadDraftSections(path));
        const steps = nextSteps({ snapshot, audit, ...(document ? { sections: document.sections } : {}), webSearch: this.settings.webSearchEnabled });
        return resolveCompanionWorkspace({
          activeNote: { path: active.path, title: active.basename },
          research: {
            projectPath,
            title: snapshot.project.title,
            stage: deriveResearchStage(snapshot, document?.sections.map(({ state }) => state)),
            ...(steps[0] ? { nextAction: steps[0].label } : {}),
            steps,
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

  /** Open the workflows picker; run the chosen workflow in the chat. */
  async openWorkflowPicker(): Promise<void> {
    new WorkflowPicker(this.app, WORKFLOWS, (wf) => void this.runWorkflow(wf)).open();
  }

  /** Run a vault workflow: ground it (active note + vault search), send its prompt. */
  async runWorkflow(wf: Workflow): Promise<void> {
    const view = await this.activateView();
    if (!view) return;
    // Workflows produce large artifacts — give them output-token headroom.
    await view.submitPrompt(wf.prompt, wf.name, ARTIFACT_MAX_TOKENS, {
      context: { activeNote: true, ...(wf.vaultSearch ? { searchVault: true } : {}) },
    });
  }

  async generateArtifactFromContext(): Promise<void> {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const hasSelection = !!mdView?.editor.getSelection().trim();
    const view = await this.activateView();
    if (!view) return;
    const target = hasSelection ? "the selected text" : "my current note";
    await view.submitPrompt(
      `Turn ${target} into a single beautiful, self-contained interactive artifact (a \`\`\`claude-html block) using the design system. Choose the best format (plan, report, table, diagram, or dashboard) for the content.`,
      `Turn ${target} into an artifact`,
      ARTIFACT_MAX_TOKENS,
      { context: { activeNote: true, selection: true } },
    );
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

  async activateSystem(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: SYSTEM_VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  async refreshMemoryView(): Promise<void> {
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

  /** Inbox-view entry point: guard + consent + enrich, then refresh open inbox views. */
  async enrichInboxItem(file: TFile, options?: { inline?: boolean; refreshInboxViews?: boolean }): Promise<EnrichRunOutcome> {
    const enrichment = this.deps.enrichment();
    const sizeFailure = enrichment.mobileSourceSizeFailure(file);
    if (sizeFailure) return sizeFailure;
    try {
      await saveEditedNote(this.app, file);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(`Couldn't save ${file.basename} before enrichment: ${detail}`, { cause });
      if (!options?.inline) new Notice(error.message);
      return { status: "failed", error };
    }
    const outcome = await enrichment.enrichFile(file, !options?.inline);
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
  inboxPendingCount(): number {
    const entries = this.app.vault.getFiles().map((f: TFile) => ({
      path: f.path,
      basename: f.basename,
      ext: f.extension,
      frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter ?? undefined,
    }));
    return inboxItems(entries, this.settings.sourceInboxFolder).length;
  }

  scheduleInboxBadgeSync(): void {
    if (this.inboxBadgeTimer !== null) window.clearTimeout(this.inboxBadgeTimer);
    this.inboxBadgeTimer = window.setTimeout(() => {
      this.inboxBadgeTimer = null;
      this.syncInboxBadge();
    }, 800);
  }

  syncInboxBadge(): void {
    const el = this.inboxRibbonEl;
    if (!el) return;
    const pending = this.settings.sourceCaptureEnabled ? this.inboxPendingCount() : 0;
    const queued = this.deps.orders().listQueuedEdits().length;
    const n = pending + queued;
    const waiting = [...(pending > 0 ? [`${pending} to type`] : []), ...(queued > 0 ? [`${queued} to review`] : [])];
    el.setAttr("aria-label", n > 0 ? `Source inbox — ${waiting.join(", ")}` : "Source inbox");
    let badge = el.querySelector<HTMLElement>(".cc-inbox-ribbon-badge");
    if (n > 0) {
      if (!badge) badge = el.createSpan({ cls: "cc-inbox-ribbon-badge" });
      badge.setText(String(n));
    } else {
      badge?.remove();
    }
  }
}
