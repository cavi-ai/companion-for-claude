import { ItemView, Modal, Notice, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { auditProject } from "../research/audit";
import type { ProjectSnapshot } from "../research/graph";
import type { ResearchRepository } from "../research/repository";
import { buildWorkbenchViewModel } from "../research/viewModel";
import { isResearchProjectChange, resolveResearchProjectLink } from "../research/workbenchRouting";
import type { IntelligenceCoordinator, IntelligenceNarratorMode } from "../research/intelligenceCoordinator";
import { ResearchIntelligencePanel } from "./ResearchIntelligencePanel";
import type { DiscoveryCoordinator } from "../discovery/coordinator";
import { DiscoveryPanel } from "./DiscoveryPanel";
import type { DraftCoordinator } from "../research/draftCoordinator";
import type { RevisionCoordinator } from "../research/revisionCoordinator";
import type { DraftSectionParseResult } from "../research/draftSections";
import type { ClaimRecord, EvidenceRecord, ResearchDocumentRecord } from "../research/types";
import { ResearchDraftPanel } from "./ResearchDraftPanel";

export const RESEARCH_WORKBENCH_VIEW_TYPE = "claude-research-workbench";
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
  Overview: { eyebrow: "AT A GLANCE", title: "Project overview", description: "See the shape, health, and immediate priorities of this research system." },
  Sources: { eyebrow: "BUILD", title: "Source library", description: "Review the material captured for this project and open the source notes behind it." },
  Evidence: { eyebrow: "BUILD", title: "Evidence review", description: "Inspect the passages and observations that can support, challenge, or qualify claims." },
  Claims: { eyebrow: "BUILD", title: "Claim map", description: "Develop the propositions this project can defend and trace each one to reviewed evidence." },
  Outline: { eyebrow: "WRITE", title: "Evidence-backed outline", description: "Shape the document around claims that already have inspectable support." },
  Draft: { eyebrow: "WRITE", title: "Grounded draft", description: "Draft and revise one supported section at a time without losing its evidence trail." },
  Audit: { eyebrow: "ASSURE", title: "Assurance audit", description: "Find broken references, unsupported claims, stale evidence, and missing locators before publication." },
  Intelligence: { eyebrow: "ASSURE", title: "Research intelligence", description: "Review deterministic tensions and request a model briefing only when it is useful." },
  Discover: { eyebrow: "EXPAND", title: "Scholarly discovery", description: "Search beyond the vault while preserving provenance, ranking factors, and deliberate import." },
};
const EMPTY_META: Partial<Record<Tab, { title: string; copy: string }>> = {
  Sources: { title: "No sources yet", copy: "Add the first source to begin building an inspectable research trail." },
  Evidence: { title: "No evidence yet", copy: "Create evidence notes from reviewed source passages before developing claims." },
  Claims: { title: "No claims yet", copy: "Develop a claim when the project has reviewed evidence worth reasoning from." },
  Outline: { title: "No outline yet", copy: "Build an outline once the project has claims with enough reviewed support." },
  Audit: { title: "No audit findings", copy: "No structural issues were found in the research records currently available." },
};

export interface ResearchWorkbenchDependencies {
  coordinator: IntelligenceCoordinator;
  narratorMode: () => IntelligenceNarratorMode;
  retainIntelligenceCoordinator?: () => void;
  releaseIntelligenceCoordinator?: () => void;
  discoveryCoordinator?: DiscoveryCoordinator;
  retainDiscoveryCoordinator?: () => void;
  releaseDiscoveryCoordinator?: () => void;
  draftCoordinator?: DraftCoordinator;
  revisionCoordinator?: RevisionCoordinator;
  openDesk?(projectPath: string): void | Promise<void>;
  askCompanion?(projectPath: string): void | Promise<void>;
}

export class ResearchWorkbenchView extends ItemView {
  private projectPath: string | undefined;
  private activeTab: Tab = "Overview";
  private renderSequence = 0;
  private intelligencePanel: ResearchIntelligencePanel | undefined;
  private intelligenceCoordinatorReleased = false;
  private discoveryPanel: DiscoveryPanel | undefined;
  private discoveryCoordinatorReleased = false;
  private draftPanel: ResearchDraftPanel | undefined;

  constructor(leaf: WorkspaceLeaf, private readonly repository: ResearchRepository, private readonly dependencies?: ResearchWorkbenchDependencies) {
    super(leaf);
    this.intelligencePanel = this.createIntelligencePanel();
    this.discoveryPanel = this.createDiscoveryPanel();
    this.draftPanel = this.createDraftPanel();
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
      try { snapshot = await this.repository.loadProject(this.projectPath); }
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
    root.empty();
    root.addClass("cc-research-workbench");

    const header = root.createEl("header", { cls: "cc-research-header" });
    const headerTop = header.createDiv({ cls: "cc-research-header-top" });
    headerTop.createEl("div", { cls: "cc-eyebrow", text: "RESEARCH WORKBENCH" });
    if (this.projectPath && (this.dependencies?.openDesk || this.dependencies?.askCompanion)) {
      const navigation = headerTop.createDiv({ cls: "cc-workspace-navigation", attr: { "aria-label": "Research workspace navigation" } });
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
    header.createEl("span", { cls: "cc-research-stage", text: vm.stage });

    const tabs = root.createEl("div", { cls: "cc-research-tabs", attr: { role: "tablist", "aria-label": "Research workbench sections" } });
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
    root.createEl("p", { text: "Repair the project note or its research frontmatter, then retry. Run Audit to inspect any records that can still be parsed." });
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
      const health = root.createDiv({ cls: "cc-research-health", attr: { role: "status", "aria-label": "Research audit health" } });
      for (const [label, value] of [["Unsupported claims", vm.health.unsupportedClaims], ["Unreviewed evidence", vm.health.unreviewedEvidence], ["Missing locators", vm.health.missingLocators], ["Broken references", vm.health.brokenReferences]] as const) {
        const metric = health.createDiv({ cls: "cc-research-health-metric", attr: { "aria-label": `${label}: ${value}` } });
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
      }
      root.createEl("h3", { text: "Next actions" });
      for (const action of vm.nextActions) this.openButton(root, action.label, action.path);
      return;
    }
    if (this.activeTab === "Audit") {
      if (!findings.length) this.renderEmptyState(root, "Audit");
      for (const finding of findings) this.openButton(root, `${finding.code}: ${finding.explanation}`, finding.path);
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
  }

  private renderActions(root: HTMLElement, snapshot?: ProjectSnapshot): void {
    const region = root.createDiv({ cls: "cc-research-actions-region" });
    region.createEl("h3", { cls: "cc-research-actions-heading", text: "Workspace actions" });
    region.createEl("p", { cls: "cc-research-actions-description", text: "Use the project tools without leaving this research context." });
    const actions = region.createDiv({ cls: "cc-research-actions", attr: { "aria-label": "Research actions" } });
    const projectPath = snapshot?.project.path;
    const contextual = ({ Overview: "Run audit", Sources: "Add source", Evidence: "Review evidence", Claims: "Create claim", Outline: "Build outline", Draft: "Build outline", Audit: "Run audit", Intelligence: "Run audit", Discover: "Add source" } as Record<Tab, string>)[this.activeTab];
    this.actionButton(actions, "Create project", undefined, undefined, () => this.openCreateProject(), contextual === "Create project");
    this.actionButton(actions, "Add source", projectPath, "Select a research project before adding a source.", () => projectPath ? this.openAddSource(projectPath) : new Notice("Select a research project first."), contextual === "Add source");
    this.actionButton(actions, "Review evidence", projectPath, "Select a research project before reviewing evidence.", () => snapshot ? this.openEvidenceReview(snapshot) : new Notice("Select a research project first."), contextual === "Review evidence");
    this.actionButton(actions, "Create claim", projectPath, "Select a research project before creating a claim.", () => snapshot ? this.openCreateClaim(snapshot) : new Notice("Select a research project first."), contextual === "Create claim");
    this.actionButton(actions, "Run audit", projectPath, undefined, () => { this.activeTab = "Audit"; void this.render(); }, contextual === "Run audit");
    this.actionButton(actions, "Build outline", projectPath, "Select a research project before building an outline.", () => snapshot ? this.openBuildOutline(snapshot) : new Notice("Select a research project first."), contextual === "Build outline");
  }

  private actionButton(root: HTMLElement, label: string, path?: string, hint?: string, action?: () => void, contextual = false): void {
    const button = root.createEl("button", { cls: `cc-research-action${contextual ? " is-contextual mod-cta" : ""}`, text: label, attr: { "aria-label": label, ...(hint ? { title: hint } : {}) } });
    button.addEventListener("click", action ?? (() => path ? void this.openPath(path) : new Notice(hint ?? "Select a research project first.")));
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

  private openCreateProject(): void {
    new ResearchInputModal(this.app, "Create research project", ["Title", "Research question", "Project folder"], async ([title, question, folder]) => {
      const record = await this.repository.createProject({ title: title ?? "", question: question ?? "", folder: folder ?? "" });
      await this.setProjectPath(record.path);
    }).open();
  }

  private openAddSource(project: string): void {
    new ResearchInputModal(this.app, "Add research source", ["Title", "Source kind", "URL or stable identifier", "Captured text (optional)"], async ([title, sourceKind, identity, capturedContent]) => {
      if (!["pdf", "web", "doi", "arxiv", "zotero", "vault"].includes(sourceKind ?? "")) throw new Error("Source kind must be pdf, web, doi, arxiv, zotero, or vault");
      const kind = sourceKind as "pdf" | "web" | "doi" | "arxiv" | "zotero" | "vault";
      await this.repository.importSource(project, { title: title ?? "", sourceKind: kind, ...(identity ? (kind === "doi" ? { doi: identity } : kind === "arxiv" ? { arxivId: identity } : { url: identity }) : {}), ...(capturedContent ? { capturedContent } : {}) });
      await this.render();
    }).open();
  }

  private openEvidenceReview(snapshot: ProjectSnapshot): void {
    const evidence = snapshot.evidence.find(({ reviewState }) => reviewState === "proposed");
    if (!evidence) { new Notice("No proposed evidence is waiting for review."); return; }
    new EvidenceReviewModal(this.app, evidence, async (state) => {
      await this.repository.reviewEvidence(evidence.path, state);
      this.activeTab = "Evidence";
      await this.render();
    }, () => this.openPath(evidence.path)).open();
  }

  private openCreateClaim(snapshot: ProjectSnapshot): void {
    const reviewed = snapshot.evidence.filter(({ reviewState }) => reviewState === "reviewed");
    if (!reviewed.length) { new Notice("Review at least one evidence item before creating a claim."); return; }
    new ClaimCreateModal(this.app, reviewed, async (input) => {
      await this.repository.createClaim({ project: snapshot.project.path, ...input });
      this.activeTab = "Claims";
      await this.render();
    }).open();
  }

  private openBuildOutline(snapshot: ProjectSnapshot): void {
    const existing = snapshot.documents.find(({ documentKind }) => documentKind === "outline");
    if (existing) { void this.openPath(existing.path); return; }
    const eligible = snapshot.claims.filter(({ reviewState, supporting }) => reviewState === "reviewed" && supporting.length > 0);
    if (!eligible.length) { new Notice("Review a supported claim before building an outline."); return; }
    new OutlineCreateModal(this.app, eligible, async (claimPaths) => {
      const outline = await this.repository.createOutline(snapshot.project.path, claimPaths);
      this.activeTab = "Outline";
      await this.render();
      await this.openPath(outline.path);
    }).open();
  }
}

function tabId(tab: Tab): string { return `cc-research-tab-${tab.toLowerCase()}`; }
export function replaceResearchProjectPath(currentPath: string | undefined, requestedPath: string | undefined, cancel: () => void): string | undefined {
  const nextPath = resolveResearchProjectLink(requestedPath);
  if (currentPath !== undefined && currentPath !== nextPath) cancel();
  return nextPath;
}
function sanitizeLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown project load error";
  return raw.replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|Bearer\s+\S+|api[_-]?key\s*[=:]\s*\S+)/gi, "[redacted]").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown project load error";
}

class ResearchInputModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly labels: string[], private readonly submit: (values: string[]) => Promise<void>) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.heading });
    const inputs = this.labels.map((label) => {
      const wrapper = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
      wrapper.createEl("label", { text: label });
      return wrapper.createEl(label.includes("text") ? "textarea" : "input");
    });
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const button = this.contentEl.createEl("button", { text: this.heading });
    button.addEventListener("click", () => void this.submit(inputs.map(({ value }) => value)).then(() => this.close()).catch((cause) => { error.setText(sanitizeLoadError(cause)); }));
  }
}

class EvidenceReviewModal extends Modal {
  constructor(app: App, private readonly evidence: EvidenceRecord, private readonly submit: (state: "reviewed" | "rejected") => Promise<void>, private readonly openNote: () => Promise<void>) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `Review ${this.evidence.title}` });
    this.contentEl.createEl("p", { cls: "cc-research-modal-meta", text: `${this.evidence.source}${this.evidence.locatorValue ? ` · ${this.evidence.locatorKind ?? "locator"} ${this.evidence.locatorValue}` : ""}` });
    this.contentEl.createEl("p", { cls: "cc-research-evidence-excerpt", text: this.evidence.excerpt });
    if (this.evidence.interpretation) this.contentEl.createEl("p", { cls: "cc-research-evidence-interpretation", text: this.evidence.interpretation });
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const actions = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
    const complete = (state: "reviewed" | "rejected") => void this.submit(state).then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    actions.createEl("button", { cls: "mod-cta", text: "Mark reviewed" }).addEventListener("click", () => complete("reviewed"));
    actions.createEl("button", { text: "Reject" }).addEventListener("click", () => complete("rejected"));
    actions.createEl("button", { text: "Open note" }).addEventListener("click", () => void this.openNote().catch((cause) => error.setText(sanitizeLoadError(cause))));
  }
}

interface ClaimModalInput {
  title: string;
  proposition: string;
  confidence: "low" | "moderate" | "high";
  supports: string[];
  challenges: string[];
  contextualizes: string[];
}

class ClaimCreateModal extends Modal {
  constructor(app: App, private readonly evidence: EvidenceRecord[], private readonly submit: (input: ClaimModalInput) => Promise<void>) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Create evidence-backed claim" });
    const title = this.field("Claim title", "input") as HTMLInputElement;
    const proposition = this.field("Proposition", "textarea") as HTMLTextAreaElement;
    const confidenceWrap = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    confidenceWrap.createEl("label", { text: "Confidence" });
    const confidence = confidenceWrap.createEl("select", { attr: { "aria-label": "Claim confidence" } });
    for (const value of ["low", "moderate", "high"]) confidence.createEl("option", { text: value, value });
    confidence.value = "moderate";
    const relations = new Map<string, Record<"supports" | "challenges" | "contextualizes", HTMLInputElement>>();
    for (const item of this.evidence) {
      const row = this.contentEl.createDiv({ cls: "cc-research-claim-evidence" });
      row.createEl("strong", { text: item.title });
      row.createEl("p", { text: item.excerpt });
      const inputs = {} as Record<"supports" | "challenges" | "contextualizes", HTMLInputElement>;
      for (const relation of ["supports", "challenges", "contextualizes"] as const) {
        const label = row.createEl("label", { text: relation });
        const input = label.createEl("input", { attr: { type: "checkbox", "aria-label": `${item.title} ${relation}` } });
        input.addEventListener("change", () => { if (input.checked) for (const other of Object.values(inputs)) if (other !== input) other.checked = false; });
        inputs[relation] = input;
      }
      relations.set(item.path, inputs);
    }
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const submitBar = this.contentEl.createDiv({ cls: "cc-research-modal-submit-bar" });
    const button = submitBar.createEl("button", { cls: "mod-cta", text: "Create claim" });
    button.addEventListener("click", () => {
      const input: ClaimModalInput = { title: title.value, proposition: proposition.value, confidence: confidence.value as ClaimModalInput["confidence"], supports: [], challenges: [], contextualizes: [] };
      for (const [path, choices] of relations) for (const relation of ["supports", "challenges", "contextualizes"] as const) if (choices[relation].checked) input[relation].push(path);
      if (!input.title.trim() || !input.proposition.trim()) { error.setText("Claim title and proposition are required."); return; }
      if (![...input.supports, ...input.challenges, ...input.contextualizes].length) { error.setText("Relate at least one reviewed evidence item."); return; }
      void this.submit(input).then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    });
  }
  private field(labelText: string, kind: "input" | "textarea"): HTMLInputElement | HTMLTextAreaElement {
    const wrapper = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    wrapper.createEl("label", { text: labelText });
    return wrapper.createEl(kind, { attr: { "aria-label": labelText } });
  }
}

class OutlineCreateModal extends Modal {
  constructor(app: App, private readonly claims: ClaimRecord[], private readonly submit: (claimPaths: string[]) => Promise<void>) { super(app); }
  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Build evidence-backed outline" });
    this.contentEl.createEl("p", { text: "Choose the reviewed, supported claims to include in the canonical outline." });
    const selected = new Map<string, HTMLInputElement>();
    for (const claim of this.claims) {
      const row = this.contentEl.createEl("label", { cls: "cc-research-outline-claim" });
      const input = row.createEl("input", { attr: { type: "checkbox", "aria-label": `Include ${claim.title}` } });
      input.checked = true;
      row.createEl("strong", { text: claim.title });
      row.createEl("span", { text: claim.proposition });
      selected.set(claim.path, input);
    }
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const button = this.contentEl.createEl("button", { cls: "mod-cta", text: "Build outline" });
    button.addEventListener("click", () => {
      const paths = [...selected].filter(([, input]) => input.checked).map(([path]) => path);
      if (!paths.length) { error.setText("Select at least one claim."); return; }
      void this.submit(paths).then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    });
  }
}
