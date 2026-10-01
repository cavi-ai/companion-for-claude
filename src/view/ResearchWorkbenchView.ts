import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { auditProject } from "../research/audit";
import { findingCopy } from "../research/findingCopy";
import { recordBasename } from "../research/nextStep";
import type { ProjectSnapshot } from "../research/graph";
import type { ResearchRepository } from "../research/repository";
import type { WebCapture } from "../research/webCapture";
import { buildWorkbenchViewModel } from "../research/viewModel";
import { isResearchProjectChange, resolveResearchProjectLink } from "../research/workbenchRouting";
import type { IntelligenceCoordinator, IntelligenceNarratorMode } from "../research/intelligenceCoordinator";
import { ResearchIntelligencePanel } from "./ResearchIntelligencePanel";
import type { DiscoveryCoordinator } from "../discovery/coordinator";
import { DiscoveryPanel } from "./DiscoveryPanel";
import type { DraftCoordinator } from "../research/draftCoordinator";
import type { RevisionCoordinator } from "../research/revisionCoordinator";
import type { DraftSectionParseResult } from "../research/draftSections";
import type { ResearchDocumentRecord } from "../research/types";
import { ResearchDraftPanel } from "./ResearchDraftPanel";
import type { ResearchModelStatus } from "../research/researchModel";
import { renderResearchModelChip } from "./researchModelChip";
import { ResearchActions, type ResearchActionsDeps, MAX_RESEARCH_SOURCE_BATCH_BYTES, MAX_RESEARCH_SOURCE_FILE_BYTES } from "./research/actions";
import { sanitizeLoadError } from "./research/shared";
import { renderCompanionChrome, type CompanionChromeDependencies } from "./companionChrome";

export const RESEARCH_WORKBENCH_VIEW_TYPE = "claude-research-workbench";
export { MAX_RESEARCH_SOURCE_BATCH_BYTES, MAX_RESEARCH_SOURCE_FILE_BYTES };
export type ResearchWorkbenchTab = "Overview" | "Sources" | "Evidence" | "Claims" | "Outline" | "Draft" | "Audit" | "Intelligence" | "Discover";
type Tab = ResearchWorkbenchTab;
const TABS: Tab[] = ["Overview", "Sources", "Evidence", "Claims", "Outline", "Draft", "Audit", "Intelligence", "Discover"];
const TAB_GROUPS: Array<{ label: string; tabs: Tab[] }> = [
  { label: "Build", tabs: ["Overview", "Sources", "Evidence", "Claims"] },
  { label: "Write", tabs: ["Outline", "Draft"] },
  { label: "Assure", tabs: ["Audit", "Intelligence"] },
  { label: "Expand", tabs: ["Discover"] },
];
const PANEL_META: Record<Tab, { eyebrow: string; title: string; description: string }> = {
  Overview: { eyebrow: "AT A GLANCE", title: "Project overview", description: "Where this project stands and what to do next." },
  Sources: { eyebrow: "BUILD · STEP 1", title: "Source library", description: "Papers, articles, and notes everything else traces back to. Add one to get started." },
  Evidence: { eyebrow: "BUILD · STEP 2", title: "Evidence review", description: "A passage is an exact quote from a source, with the page or section it came from. Check each one before a claim relies on it." },
  Claims: { eyebrow: "BUILD · STEP 3", title: "Claim map", description: "A claim is one statement your document argues. Each one points to the passages that back it up, push back on it, or give context." },
  Outline: { eyebrow: "WRITE · STEP 4", title: "Outline", description: "Your checked, backed-up claims arranged into the shape of the document." },
  Draft: { eyebrow: "WRITE · STEP 5", title: "Draft", description: "Write one section at a time. Each paragraph keeps the passages it came from." },
  Audit: { eyebrow: "ASSURE", title: "Project check", description: "Problems to fix before you publish: claims without support, passages to re-check, broken links." },
  Intelligence: { eyebrow: "ASSURE", title: "Insights", description: "Tensions between your passages and claims, found automatically. Ask for a written briefing when you want one." },
  Discover: { eyebrow: "EXPAND", title: "Find sources", description: "Search OpenAlex, Crossref, and arXiv beyond your vault, then add what you want." },
};
const EMPTY_META: Partial<Record<Tab, { title: string; copy: string; example?: string }>> = {
  Sources: { title: "No sources yet", copy: "Add your first source: paste a link, drop a file, or pick a note from your vault." },
  Evidence: { title: "No passages yet", copy: "Open a source and pick out the exact passage that matters, with its page or section. Then check it here.", example: "e.g. “Participants took 23 min to refocus after an interruption” — page 4." },
  Claims: { title: "No claims yet", copy: "Once a passage is checked, state the one thing it shows. Claude can draft the claim for you.", example: "e.g. “Frequent task-switching delays a return to deep work.”" },
  Outline: { title: "No outline yet", copy: "Build the outline once a claim is checked and backed up by a passage." },
  Audit: { title: "Nothing to fix", copy: "No problems found in this project." },
};

export interface ResearchWorkbenchDependencies {
  chrome?: CompanionChromeDependencies;
  coordinator: IntelligenceCoordinator;
  narratorMode: () => IntelligenceNarratorMode;
  researchStatus?(): ResearchModelStatus;
  openResearchSettings?(): void;
  retainIntelligenceCoordinator?: () => void;
  releaseIntelligenceCoordinator?: () => void;
  discoveryCoordinator?: DiscoveryCoordinator;
  retainDiscoveryCoordinator?: () => void;
  releaseDiscoveryCoordinator?: () => void;
  draftCoordinator?: DraftCoordinator;
  revisionCoordinator?: RevisionCoordinator;
  /** Chat-free rewrite helper (inline rewrite) — sharpens draft prose, optionally grounded in supplied context. */
  rewriteText?: (input: { text: string; instruction: string; context?: string }) => Promise<string>;
  /** Defuddle web capture for URL sources (renderer only — absent in tests/headless). */
  captureWeb?: WebCapture;
  /** Persist a dropped/uploaded file into the project's source-assets folder; returns its vault path. */
  saveAsset?: (projectPath: string, name: string, data: ArrayBuffer) => Promise<string>;
  /** Best-effort content tags (autoTagger) applied to freshly clipped sources. */
  suggestTags?: (content: string) => Promise<string[]>;
  /** Shared with the Research Desk so both surfaces run the same steps. */
  actions?: ResearchActions;
  openDesk?(projectPath: string): void | Promise<void>;
  askCompanion?(projectPath: string): void | Promise<void>;
}

export class ResearchWorkbenchView extends ItemView {
  private disposeChrome: ((remove?: boolean) => void) | null = null;
  private projectPath: string | undefined;
  private activeTab: Tab = "Overview";
  private renderSequence = 0;
  private intelligencePanel: ResearchIntelligencePanel | undefined;
  private intelligenceCoordinatorReleased = false;
  private discoveryPanel: DiscoveryPanel | undefined;
  private discoveryCoordinatorReleased = false;
  private draftPanel: ResearchDraftPanel | undefined;
  private readonly actions: ResearchActions;

  constructor(leaf: WorkspaceLeaf, private readonly repository: ResearchRepository, private readonly dependencies?: ResearchWorkbenchDependencies) {
    super(leaf);
    this.intelligencePanel = this.createIntelligencePanel();
    this.discoveryPanel = this.createDiscoveryPanel();
    this.draftPanel = this.createDraftPanel();
    this.actions = dependencies?.actions ?? new ResearchActions(this.localActionDeps());
  }

  private localActionDeps(): ResearchActionsDeps {
    const d = this.dependencies;
    return {
      app: this.app,
      repository: this.repository,
      ...(d?.rewriteText ? { rewriteText: d.rewriteText } : {}),
      ...(d?.captureWeb ? { captureWeb: d.captureWeb } : {}),
      ...(d?.saveAsset ? { saveAsset: d.saveAsset } : {}),
      ...(d?.suggestTags ? { suggestTags: d.suggestTags } : {}),
      openPath: (path) => this.openPath(path),
      changed: () => this.render(),
      openWorkbench: async (project, tab, path) => { if (project !== this.projectPath) await this.setProjectPath(project); await this.focus(tab, path); },
      selectProject: async (path) => { this.activeTab = "Sources"; await this.setProjectPath(path); },
    };
  }

  getViewType(): string { return RESEARCH_WORKBENCH_VIEW_TYPE; }
  getDisplayText(): string { return "Research workbench"; }
  override getIcon(): string { return "microscope"; }

  async setProjectPath(projectPath?: string): Promise<void> {
    this.projectPath = replaceResearchProjectPath(this.projectPath, projectPath, () => this.cancelIntelligence());
    await this.render();
  }

  getProjectPath(): string | undefined { return this.projectPath; }

  async focus(tab: ResearchWorkbenchTab, path?: string): Promise<void> {
    this.activeTab = tab;
    await this.render();
    if (path) await this.openPath(path);
  }

  isRelevantChange(path: string, oldPath?: string): boolean {
    return isResearchProjectChange(this.projectPath, path, oldPath);
  }

  override async onOpen(): Promise<void> {
    if (this.intelligenceCoordinatorReleased) {
      this.dependencies?.retainIntelligenceCoordinator?.();
      this.intelligenceCoordinatorReleased = false;
    }
    if (this.discoveryCoordinatorReleased) {
      this.dependencies?.retainDiscoveryCoordinator?.();
      this.discoveryCoordinatorReleased = false;
    }
    this.intelligencePanel ??= this.createIntelligencePanel();
    this.discoveryPanel ??= this.createDiscoveryPanel();
    await this.render();
  }
  override async onClose(): Promise<void> {
    this.disposeChrome?.(false);
    this.disposeChrome = null;
    this.renderSequence += 1;
    if (this.intelligencePanel) {
      this.intelligencePanel.dispose();
      this.intelligencePanel = undefined;
    }
    else this.dependencies?.coordinator.cancel();
    if (!this.intelligenceCoordinatorReleased) {
      this.intelligenceCoordinatorReleased = true;
      this.dependencies?.releaseIntelligenceCoordinator?.();
    }
    if (this.discoveryPanel) { this.discoveryPanel.dispose(); this.discoveryPanel = undefined; }
    else this.dependencies?.discoveryCoordinator?.cancel();
    if (!this.discoveryCoordinatorReleased) {
      this.discoveryCoordinatorReleased = true;
      this.dependencies?.releaseDiscoveryCoordinator?.();
    }
    this.draftPanel?.dispose();
  }

  async render(): Promise<void> {
    const sequence = ++this.renderSequence;
    let snapshot: ProjectSnapshot | undefined;
    let loadError: string | undefined;
    if (this.projectPath) {
      try { snapshot = await this.repository.loadProject(this.projectPath, { refreshBinaryFingerprints: this.activeTab === "Draft" || this.activeTab === "Audit" || this.activeTab === "Intelligence" }); }
      catch (error) { loadError = sanitizeLoadError(error); }
    }
    if (sequence !== this.renderSequence) return;
    let draftDocument: ResearchDocumentRecord | undefined;
    let draftSections: DraftSectionParseResult | undefined;
    if (snapshot && this.activeTab === "Draft") {
      draftDocument = snapshot.documents.find(({ documentKind }) => documentKind === "draft") ?? snapshot.documents.find(({ documentKind }) => documentKind === "outline");
      if (draftDocument) {
        try { draftSections = await this.repository.loadDraftSections(draftDocument.path); }
        catch (error) { draftSections = { sections: [], issues: [sanitizeLoadError(error)] }; }
      }
    }
    if (sequence !== this.renderSequence) return;
    const findings = snapshot ? auditProject(snapshot) : [];
    const vm = buildWorkbenchViewModel(snapshot, findings);
    const root = this.contentEl;
    this.disposeChrome?.();
    this.disposeChrome = null;
    root.empty();
    root.addClass("cc-research-workbench");
    if (this.dependencies?.chrome) {
      const chrome = this.dependencies.chrome;
      this.disposeChrome = renderCompanionChrome(root, "research-workbench", "Research Workbench", {
        ...chrome,
        snapshot: () => ({
          ...chrome.snapshot(),
          ...(snapshot ? { activeProject: snapshot.project.title } : {}),
          activeResearchTab: this.activeTab,
        }),
      });
    }

    const header = root.createEl("header", { cls: "cc-research-header" });
    const headerTop = header.createDiv({ cls: "cc-research-header-top" });
    headerTop.createDiv({ cls: "cc-eyebrow", text: "RESEARCH WORKBENCH" });
    if ((this.projectPath && (this.dependencies?.openDesk || this.dependencies?.askCompanion)) || this.dependencies?.researchStatus) {
      const navigation = headerTop.createDiv({ cls: "cc-workspace-navigation", attr: { "aria-label": "Research workspace navigation" } });
      renderResearchModelChip(navigation, this.dependencies?.researchStatus?.(), () => this.dependencies?.openResearchSettings?.());
      if (this.dependencies.openDesk) {
        const desk = navigation.createEl("button", { text: "Research Desk" });
        desk.addEventListener("click", () => void this.dependencies?.openDesk?.(this.projectPath!));
      }
      if (this.dependencies.askCompanion) {
        const ask = navigation.createEl("button", { cls: "cc-workspace-companion-action", text: "Ask Companion" });
        ask.addEventListener("click", () => void this.dependencies?.askCompanion?.(this.projectPath!));
      }
    }
    header.createEl("h2", { text: vm.title });
    header.createEl("p", { cls: "cc-research-question", text: vm.question });
    header.createSpan({ cls: "cc-research-stage", text: vm.stage });

    const tabs = root.createDiv({ cls: "cc-research-tabs", attr: { role: "tablist", "aria-label": "Research workbench sections" } });
    for (const group of TAB_GROUPS) {
      const groupRoot = tabs.createDiv({ cls: "cc-research-tab-group" });
      groupRoot.createSpan({ cls: "cc-research-tab-group-label", text: group.label });
      const groupTabs = groupRoot.createDiv({ cls: "cc-research-tab-buttons" });
      for (const tab of group.tabs) {
        const index = TABS.indexOf(tab); const id = tabId(tab);
        const button = groupTabs.createEl("button", { text: tab, attr: { id, role: "tab", "aria-selected": String(tab === this.activeTab), "aria-controls": `${id}-panel`, tabindex: tab === this.activeTab ? "0" : "-1" } });
        if (tab === this.activeTab) button.addClass("is-active");
        button.addEventListener("click", () => { this.activeTab = tab; void this.render(); });
        button.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
          this.activeTab = TABS[next] ?? "Overview";
          void this.render().then(() => this.contentEl.querySelector<HTMLElement>(`#${tabId(this.activeTab)}`)?.focus());
        });
      }
    }
    const compactTabs = root.createEl("select", { cls: "cc-research-tab-select", attr: { "aria-label": "Research workbench section" } });
    for (const tab of TABS) compactTabs.createEl("option", { text: tab, value: tab });
    compactTabs.value = this.activeTab;
    compactTabs.addEventListener("change", () => { this.activeTab = compactTabs.value as Tab; void this.render(); });

    const activeId = tabId(this.activeTab);
    const panel = root.createEl("section", { cls: "cc-research-panel", attr: { id: `${activeId}-panel`, role: "tabpanel", "aria-labelledby": activeId } });
    if (loadError && this.projectPath) this.renderError(panel, this.projectPath, loadError);
    else if (!snapshot) this.renderEmpty(panel);
    else this.renderTab(panel, snapshot, findings, draftDocument, draftSections);
    this.renderActions(root, snapshot);
  }

  private renderEmpty(root: HTMLElement): void {
    root.createEl("h3", { text: "No research project selected" });
    root.createEl("p", { text: "Open a research project note, then reopen this view. Project notes are the canonical place to frame the question." });
  }

  private renderError(root: HTMLElement, projectPath: string, message: string): void {
    root.createEl("h3", { text: "Research project could not be loaded" });
    root.createEl("p", { cls: "cc-research-project-path", text: projectPath });
    root.createEl("p", { cls: "cc-research-error", text: message });
    root.createEl("p", { text: "Fix the project note, then try again. Run the check to see what else needs attention." });
    this.actionButton(root, "Run audit", undefined, undefined, () => { this.activeTab = "Audit"; void this.render(); });
  }

  private renderTab(root: HTMLElement, snapshot: ProjectSnapshot, findings: ReturnType<typeof auditProject>, draftDocument?: ResearchDocumentRecord, draftSections?: DraftSectionParseResult): void {
    const vm = buildWorkbenchViewModel(snapshot, findings);
    this.renderPanelIntro(root);
    if (this.activeTab === "Intelligence") {
      if (this.intelligencePanel) this.intelligencePanel.render(root, snapshot);
      else root.createEl("p", { text: "Research intelligence is unavailable." });
      return;
    }
    if (this.activeTab === "Discover") {
      if (this.discoveryPanel) this.discoveryPanel.render(root, snapshot);
      else root.createEl("p", { text: "Scholarly discovery is unavailable." });
      return;
    }
    if (this.activeTab === "Draft") {
      if (this.draftPanel) this.draftPanel.render(root, snapshot, draftDocument, draftSections);
      else root.createEl("p", { text: "Section drafting is unavailable." });
      return;
    }
    if (this.activeTab === "Overview") {
      const grid = root.createDiv({ cls: "cc-research-metrics" });
      for (const [label, value] of [["Sources", vm.counts.sources], ["Evidence", vm.counts.evidence], ["Claims", vm.counts.claims], ["Open questions", vm.counts.openQuestions]] as const) {
        const card = grid.createEl("button", { cls: "cc-research-metric", attr: { "aria-label": `Open ${label.toLowerCase()}` } });
        card.createEl("strong", { text: String(value) }); card.createSpan({ text: label });
        card.addEventListener("click", () => { this.activeTab = label === "Open questions" ? "Overview" : label; void this.render(); });
      }
      root.createEl("h3", { text: "Audit health" });
      const health = root.createDiv({ cls: "cc-research-health", attr: { role: "status", "aria-label": "Project health" } });
      for (const [label, value] of [["Claims without support", vm.health.unsupportedClaims], ["Passages to check", vm.health.unreviewedEvidence], ["Passages without a page or section", vm.health.missingLocators], ["Broken links", vm.health.brokenReferences]] as const) {
        const metric = health.createDiv({ cls: "cc-research-health-metric", attr: { "aria-label": `${label}: ${value}` } });
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
      }
      root.createEl("h3", { text: "Next actions" });
      for (const action of vm.nextActions) {
        const { run, path } = action;
        if (run) this.runButton(root, action.label, () => void this.actions.run({ run, ...(path ? { path } : {}) }, snapshot));
        else this.openButton(root, action.label, path);
      }
      return;
    }
    if (this.activeTab === "Audit") {
      if (!findings.length) this.renderEmptyState(root, "Audit");
      for (const finding of findings) {
        const copy = findingCopy(finding.code, recordBasename(finding.path));
        const row = root.createEl("button", { cls: "cc-research-open" });
        row.createDiv({ cls: "cc-research-finding-label", text: copy.label });
        row.createDiv({ cls: "cc-research-finding-reason", text: copy.reason });
        row.addEventListener("click", () => void this.openPath(finding.path));
      }
      return;
    }
    const records = this.activeTab === "Sources" ? snapshot.sources : this.activeTab === "Evidence" ? snapshot.evidence : this.activeTab === "Claims" ? snapshot.claims : snapshot.documents.filter(({ documentKind }) => documentKind === "outline");
    if (!records.length) this.renderEmptyState(root, this.activeTab);
    else {
      const list = root.createDiv({ cls: "cc-research-record-list", attr: { "aria-label": `${this.activeTab} records` } });
      for (const record of records) {
        const button = list.createEl("button", { cls: "cc-research-record", attr: { "aria-label": `Open ${record.title}` } });
        button.createSpan({ cls: "cc-research-record-title", text: record.title });
        button.createSpan({ cls: "cc-research-record-path", text: record.path });
        button.addEventListener("click", () => void this.openPath(record.path));
      }
    }
  }

  private renderPanelIntro(root: HTMLElement): void {
    const meta = PANEL_META[this.activeTab];
    const intro = root.createDiv({ cls: "cc-research-panel-intro" });
    intro.createDiv({ cls: "cc-research-panel-eyebrow", text: meta.eyebrow });
    intro.createEl("h3", { cls: "cc-research-panel-title", text: meta.title });
    intro.createEl("p", { cls: "cc-research-panel-description", text: meta.description });
  }

  private renderEmptyState(root: HTMLElement, tab: Tab): void {
    const meta = EMPTY_META[tab] ?? { title: `Nothing in ${tab.toLowerCase()} yet`, copy: "This panel will become available as the project develops." };
    const state = root.createDiv({ cls: "cc-research-empty-state", attr: { role: "status" } });
    state.createEl("h4", { cls: "cc-research-empty-state-title", text: meta.title });
    state.createEl("p", { cls: "cc-research-empty-state-copy", text: meta.copy });
    if ("example" in meta && meta.example) state.createEl("p", { cls: "cc-research-empty-state-example", text: meta.example });
  }

  private renderActions(root: HTMLElement, snapshot?: ProjectSnapshot): void {
    const region = root.createDiv({ cls: "cc-research-actions-region" });
    region.createEl("h3", { cls: "cc-research-actions-heading", text: "Workspace actions" });
    region.createEl("p", { cls: "cc-research-actions-description", text: "Use the project tools without leaving this research context." });
    const actions = region.createDiv({ cls: "cc-research-actions", attr: { "aria-label": "Research actions" } });
    const projectPath = snapshot?.project.path;
    const extractFirst = !snapshot || snapshot.sources.some(({ path }) => !snapshot.evidence.some(({ source }) => source === path)) || !snapshot.evidence.some(({ reviewState }) => reviewState === "proposed");
    const contextual = ({ Overview: "Run audit", Sources: "Add source", Evidence: extractFirst ? "Extract evidence" : "Review evidence", Claims: "Create claim", Outline: "Build outline", Draft: "Build outline", Audit: "Run audit", Intelligence: "Run audit", Discover: "Add source" } as Record<Tab, string>)[this.activeTab];
    this.actionButton(actions, "Create project", undefined, undefined, () => this.actions.createProject(), contextual === "Create project");
    this.actionButton(actions, "Add source", projectPath, "Select a research project before adding a source.", () => projectPath ? this.actions.addSource(projectPath) : new Notice("Select a research project first."), contextual === "Add source");
    this.actionButton(actions, "Extract evidence", projectPath, "Select a research project before extracting evidence.", () => { if (snapshot) { this.activeTab = "Evidence"; this.actions.extractEvidence(snapshot); } else new Notice("Select a research project first."); }, contextual === "Extract evidence");
    this.actionButton(actions, "Review evidence", projectPath, "Select a research project before reviewing evidence.", () => { if (snapshot) { this.activeTab = "Evidence"; this.actions.reviewEvidence(snapshot); } else new Notice("Select a research project first."); }, contextual === "Review evidence");
    this.actionButton(actions, "Create claim", projectPath, "Select a research project before creating a claim.", () => { if (snapshot) { this.activeTab = "Claims"; this.actions.createClaim(snapshot); } else new Notice("Select a research project first."); }, contextual === "Create claim");
    this.actionButton(actions, "Run audit", projectPath, undefined, () => { this.activeTab = "Audit"; void this.render(); }, contextual === "Run audit");
    this.actionButton(actions, "Build outline", projectPath, "Select a research project before building an outline.", () => { if (snapshot) { this.activeTab = "Outline"; this.actions.buildOutline(snapshot); } else new Notice("Select a research project first."); }, contextual === "Build outline");
  }

  private actionButton(root: HTMLElement, label: string, path?: string, hint?: string, action?: () => void, contextual = false): void {
    const button = root.createEl("button", { cls: `cc-research-action${contextual ? " is-contextual mod-cta" : ""}`, text: label, attr: { "aria-label": label, ...(hint ? { title: hint } : {}) } });
    button.addEventListener("click", action ?? (() => path ? void this.openPath(path) : new Notice(hint ?? "Select a research project first.")));
  }

  private runButton(root: HTMLElement, label: string, run: () => void): void {
    root.createEl("button", { cls: "cc-research-open", text: label }).addEventListener("click", run);
  }

  private openButton(root: HTMLElement, label: string, path?: string): void {
    const button = root.createEl("button", { cls: "cc-research-open", text: label });
    if (path) button.addEventListener("click", () => void this.openPath(path));
    else button.disabled = true;
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Research note not found: ${path}`);
  }

  private cancelIntelligence(): void {
    if (this.intelligencePanel) this.intelligencePanel.cancel();
    else this.dependencies?.coordinator.cancel();
    if (this.discoveryPanel) this.discoveryPanel.cancel();
    else this.dependencies?.discoveryCoordinator?.cancel();
    this.draftPanel?.dispose();
  }

  private createDiscoveryPanel(): DiscoveryPanel | undefined {
    if (!this.dependencies?.discoveryCoordinator) return undefined;
    return new DiscoveryPanel({ coordinator: this.dependencies.discoveryCoordinator, openPath: (path) => this.openPath(path), rerender: () => this.render() });
  }

  private createIntelligencePanel(): ResearchIntelligencePanel | undefined {
    if (!this.dependencies) return undefined;
    return new ResearchIntelligencePanel({
      coordinator: this.dependencies.coordinator,
      openPath: (path) => this.openPath(path),
      rerender: () => this.render(),
    });
  }

  private createDraftPanel(): ResearchDraftPanel | undefined {
    if (!this.dependencies?.draftCoordinator) return undefined;
    return new ResearchDraftPanel({ coordinator: this.dependencies.draftCoordinator, ...(this.dependencies.revisionCoordinator ? { revisionCoordinator: this.dependencies.revisionCoordinator } : {}), repository: this.repository, rerender: () => this.render() });
  }
}

function tabId(tab: Tab): string { return `cc-research-tab-${tab.toLowerCase()}`; }
export function replaceResearchProjectPath(currentPath: string | undefined, requestedPath: string | undefined, cancel: () => void): string | undefined {
  const nextPath = resolveResearchProjectLink(requestedPath);
  if (currentPath !== undefined && currentPath !== nextPath) cancel();
  return nextPath;
}
