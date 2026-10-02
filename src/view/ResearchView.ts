import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { buildArgument, CLAIM_STATUS_LABEL, type ArgumentModel, type ClaimCard, type RecordLink } from "../research/argument";
import { auditProject, type AuditFinding } from "../research/audit";
import type { DraftCoordinator } from "../research/draftCoordinator";
import { findingCopy } from "../research/findingCopy";
import { recordBasename, type ProjectSnapshot } from "../research/graph";
import { analyzeProjectIntelligence } from "../research/intelligence";
import { buildResearchAgentPrompt, nextSteps, type NextStep } from "../research/nextSteps";
import type { ResearchRepository } from "../research/repository";
import type { ResearchModelStatus } from "../research/researchModel";
import type { RevisionCoordinator } from "../research/revisionCoordinator";
import { documentSections, type DocumentSections } from "../research/sectionStatus";
import { isResearchProjectChange } from "../research/workbenchRouting";
import { renderCompanionChrome, type CompanionChromeDependencies } from "./companionChrome";
import { ResearchDraftPanel } from "./ResearchDraftPanel";
import type { ResearchActions } from "./research/actions";
import { sanitizeLoadError } from "./research/shared";
import { renderResearchModelChip } from "./researchModelChip";

export const RESEARCH_DESK_VIEW_TYPE = "claude-research-desk";
export const RESEARCH_WORKBENCH_VIEW_TYPE = "claude-research-workbench";
const NEW_PROJECT = "__new__";
const count = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? "" : "s"}`;

export interface ResearchViewDependencies {
  chrome?: CompanionChromeDependencies;
  actions: ResearchActions;
  askResearch(projectPath: string, prompt: string, display: string): boolean | Promise<boolean>;
  openPath(path: string): void | Promise<void>;
  webSearchEnabled(): boolean;
  draftCoordinator?: DraftCoordinator;
  revisionCoordinator?: RevisionCoordinator;
  openDiscovery?(snapshot: ProjectSnapshot): void;
  startFromActiveNote?(): void | Promise<void>;
  researchStatus?(): ResearchModelStatus;
  openResearchSettings?(): void;
}

type ResearchViewRepository = Pick<ResearchRepository, "listProjects" | "loadProject" | "loadDraftSections" | "convertDocumentFormat">;

export class ResearchView extends ItemView {
  private disposeChrome: ((remove?: boolean) => void) | null = null;
  private projectPath: string | undefined;
  private renderSequence = 0;
  private sectionsOpen = false;
  private instruction = "";
  private askFocus: { start: number; end: number } | undefined;
  private restoreFocus: { start: number; end: number } | undefined;
  private rendering = false;
  private readonly expanded = new Set<string>();
  private readonly draftPanel: ResearchDraftPanel | undefined;

  constructor(leaf: WorkspaceLeaf, private readonly repository: ResearchViewRepository, private readonly deps: ResearchViewDependencies) {
    super(leaf);
    this.draftPanel = deps.draftCoordinator
      ? new ResearchDraftPanel({ coordinator: deps.draftCoordinator, ...(deps.revisionCoordinator ? { revisionCoordinator: deps.revisionCoordinator } : {}), repository: repository as ResearchRepository, rerender: () => this.render() })
      : undefined;
  }

  getViewType(): string { return RESEARCH_DESK_VIEW_TYPE; }
  getDisplayText(): string { return "Research Desk"; }
  override getIcon(): string { return "layout-dashboard"; }
  getProjectPath(): string | undefined { return this.projectPath; }
  isRelevantChange(path: string, oldPath?: string): boolean { return isResearchProjectChange(this.projectPath, path, oldPath); }

  async setProjectPath(path?: string): Promise<void> {
    if (path !== this.projectPath) {
      this.draftPanel?.dispose();
      this.sectionsOpen = false;
      this.expanded.clear();
    }
    this.projectPath = path;
    await this.render();
  }

  override async onOpen(): Promise<void> { await this.render(); }

  override async onClose(): Promise<void> {
    this.renderSequence += 1;
    this.draftPanel?.dispose();
    this.disposeChrome?.(false);
    this.disposeChrome = null;
  }

  async render(): Promise<void> {
    const sequence = ++this.renderSequence;
    const projects = await this.repository.listProjects();
    if (sequence !== this.renderSequence) return;
    if (!this.projectPath && projects.length) this.projectPath = projects[0]?.path;
    let snapshot: ProjectSnapshot | undefined;
    let loadError: string | undefined;
    if (this.projectPath) {
      try { snapshot = await this.repository.loadProject(this.projectPath, { refreshBinaryFingerprints: true }); }
      catch (error) { loadError = sanitizeLoadError(error); }
    }
    const document = snapshot ? await documentSections(snapshot, (path) => this.repository.loadDraftSections(path)) : undefined;
    if (sequence !== this.renderSequence) return;

    const root = this.contentEl;
    this.disposeChrome?.();
    this.disposeChrome = null;
    this.restoreFocus = this.askFocus;
    this.rendering = true;
    root.empty();
    root.addClass("cc-research-desk");
    if (this.deps.chrome) {
      const chrome = this.deps.chrome;
      this.disposeChrome = renderCompanionChrome(root, "research-desk", "Research Desk", {
        ...chrome,
        snapshot: () => ({ ...chrome.snapshot(), ...(snapshot ? { activeProject: snapshot.project.title } : {}) }),
      });
    }
    if (!snapshot) { this.renderEmpty(root, projects, loadError); this.rendering = false; return; }
    const audit = auditProject(snapshot);
    const argument = buildArgument(snapshot, audit, analyzeProjectIntelligence(snapshot), document?.sections);
    const steps = nextSteps({ snapshot, audit, ...(document ? { sections: document.sections } : {}), webSearch: this.deps.webSearchEnabled() });
    this.renderHeader(root, snapshot, projects);
    this.renderFixFirst(root, argument.fixFirst);
    this.renderAsk(root, snapshot, steps, document);
    this.renderArgument(root, snapshot, argument);
    this.renderDocument(root, snapshot, document);
    this.renderSources(root, snapshot);
    this.rendering = false;
  }

  private renderHeader(root: HTMLElement, snapshot: ProjectSnapshot, projects: Array<{ path: string; title: string }>): void {
    const header = root.createEl("header", { cls: "cc-desk-header" });
    const row = header.createDiv({ cls: "cc-desk-header-row" });
    const select = row.createEl("select", { cls: "cc-desk-project", attr: { "aria-label": "Active research project" } });
    for (const project of projects) select.createEl("option", { text: project.title, value: project.path });
    select.createEl("option", { text: "New project…", value: NEW_PROJECT });
    select.value = snapshot.project.path;
    select.addEventListener("change", () => {
      if (select.value !== NEW_PROJECT) { void this.setProjectPath(select.value); return; }
      select.value = snapshot.project.path;
      this.deps.actions.createProject();
    });
    renderResearchModelChip(row, this.deps.researchStatus?.(), () => this.deps.openResearchSettings?.());
    if (this.deps.startFromActiveNote) {
      const fromNote = row.createEl("button", { cls: "cc-desk-from-note", text: "From active note", attr: { title: "New project from the note you have open" } });
      fromNote.addEventListener("click", () => void this.deps.startFromActiveNote?.());
    }
    header.createEl("h2", { text: snapshot.project.title });
    header.createEl("p", { cls: "cc-desk-question", text: snapshot.project.question });
  }

  private renderFixFirst(root: HTMLElement, findings: AuditFinding[]): void {
    if (!findings.length) return;
    const strip = root.createEl("section", { cls: "cc-desk-fix", attr: { "aria-label": "Fix first" } });
    strip.createEl("h3", { text: "Fix first" });
    for (const finding of findings) {
      const copy = findingCopy(finding.code, recordBasename(finding.path));
      const row = strip.createEl("button", { cls: "cc-desk-fix-row" });
      row.createSpan({ cls: "cc-desk-fix-label", text: copy.label });
      row.createSpan({ cls: "cc-desk-fix-reason", text: copy.reason });
      row.addEventListener("click", () => void this.deps.openPath(finding.path));
    }
  }

  private renderAsk(root: HTMLElement, snapshot: ProjectSnapshot, steps: NextStep[], document: DocumentSections | undefined): void {
    const ask = root.createEl("section", { cls: "cc-desk-ask", attr: { "aria-label": "Ask Claude" } });
    ask.createEl("h3", { text: "Ask Claude" });
    const list = ask.createDiv({ cls: "cc-desk-steps" });
    for (const step of steps) {
      const button = list.createEl("button", { cls: `cc-desk-step is-${step.kind}`, text: step.label });
      button.addEventListener("click", () => void this.runStep(step, snapshot, document));
    }
    const form = ask.createDiv({ cls: "cc-desk-ask-form" });
    const input = form.createEl("textarea", { cls: "cc-desk-ask-input", attr: { "aria-label": "Instruction for Claude", placeholder: "Tell Claude what to do next…", rows: "2" } });
    input.value = this.instruction;
    const caret = () => ({ start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length });
    input.addEventListener("focus", () => { this.askFocus = caret(); });
    input.addEventListener("blur", () => { if (!this.rendering) this.askFocus = undefined; });
    input.addEventListener("input", () => { this.instruction = input.value; if (this.askFocus) this.askFocus = caret(); });
    for (const type of ["keyup", "click"]) input.addEventListener(type, () => { if (this.askFocus) this.askFocus = caret(); });
    if (this.restoreFocus) {
      const { start, end } = this.restoreFocus;
      input.focus();
      input.setSelectionRange(start, end);
      this.askFocus = { start, end };
      this.restoreFocus = undefined;
    }
    const send = form.createEl("button", { cls: "mod-cta", text: "Send" });
    send.addEventListener("click", () => {
      const instruction = input.value.trim();
      if (!instruction) return;
      void (async () => {
        if (!await this.deps.askResearch(snapshot.project.path, buildResearchAgentPrompt(snapshot.project, instruction), instruction)) return;
        this.instruction = "";
        input.value = "";
      })();
    });
  }

  private async runStep(step: NextStep, snapshot: ProjectSnapshot, document: DocumentSections | undefined): Promise<void> {
    if (step.kind === "chat") {
      if (step.prompt) await this.deps.askResearch(snapshot.project.path, step.prompt, step.label);
      return;
    }
    if (step.kind === "draft-section") {
      const section = document?.parsed.sections.find(({ envelope }) => envelope.id === step.sectionId);
      if (!section || !this.draftPanel) { new Notice("That section can't be drafted right now."); return; }
      this.sectionsOpen = true;
      await this.render();
      await this.draftPanel.preview(snapshot, section);
      return;
    }
    await this.deps.actions.runStep(step, snapshot);
  }

  private renderArgument(root: HTMLElement, snapshot: ProjectSnapshot, argument: ArgumentModel): void {
    const section = root.createEl("section", { cls: "cc-desk-argument", attr: { "aria-label": "Argument" } });
    const head = section.createDiv({ cls: "cc-desk-section-heading" });
    head.createEl("h3", { text: "Argument" });
    head.createSpan({ cls: "cc-desk-counts", text: `${count(snapshot.sources.length, "source")} · ${count(snapshot.evidence.length, "passage")} · ${count(snapshot.claims.length, "claim")}` });
    const add = head.createEl("button", { text: "New claim" });
    add.addEventListener("click", () => this.deps.actions.createClaim(snapshot));
    if (!argument.cards.length) section.createEl("p", { cls: "cc-desk-empty-copy", text: "No claims yet. Ask Claude to develop one from your passages, or add one yourself." });
    for (const card of argument.cards) this.renderCard(section, snapshot, card);
    this.renderGroup(section, "Unused passages", argument.unusedPassages);
    this.renderGroup(section, "Unread sources", argument.unreadSources);
    this.renderGroup(section, "Rejected", argument.rejected);
  }

  private renderCard(parent: HTMLElement, snapshot: ProjectSnapshot, card: ClaimCard): void {
    const open = this.expanded.has(card.path);
    const article = parent.createEl("article", { cls: `cc-desk-card is-${card.status}` });
    const head = article.createEl("button", { cls: "cc-desk-card-head", attr: { "aria-expanded": String(open) } });
    head.createSpan({ cls: "cc-desk-card-title", text: card.title });
    head.createSpan({ cls: `cc-desk-chip is-${card.status}`, text: CLAIM_STATUS_LABEL[card.status] });
    head.addEventListener("click", () => {
      if (open) this.expanded.delete(card.path);
      else this.expanded.add(card.path);
      void this.render();
    });
    article.createDiv({ cls: "cc-desk-card-counts", text: `${card.counts.supports} supporting · ${card.counts.challenges} challenging · ${card.counts.context} context` });
    for (const note of card.notes) article.createDiv({ cls: "cc-desk-card-note", text: note });
    if (!open) return;
    article.createEl("p", { cls: "cc-desk-card-proposition", text: card.proposition });
    const rows = article.createEl("ul", { cls: "cc-desk-passages" });
    for (const row of card.passages) {
      const item = rows.createEl("li");
      const relation = row.relation === "supports" ? "Supports" : row.relation === "challenges" ? "Challenges" : "Context";
      const link = item.createEl("button", { cls: "cc-desk-passage", text: `${relation}: ${row.title}` });
      link.addEventListener("click", () => void this.deps.openPath(row.path));
      item.createSpan({ cls: "cc-desk-passage-meta", text: [row.sourceTitle, row.locator, row.flag].filter(Boolean).join(" · ") });
    }
    const actions = article.createDiv({ cls: "cc-desk-card-actions" });
    const check = actions.createEl("button", { text: "Check claim" });
    check.addEventListener("click", () => this.deps.actions.reviewClaim(snapshot, card.path));
    const note = actions.createEl("button", { text: "Open note" });
    note.addEventListener("click", () => void this.deps.openPath(card.path));
  }

  private renderGroup(parent: HTMLElement, label: string, items: RecordLink[]): void {
    if (!items.length) return;
    const group = parent.createEl("details", { cls: "cc-desk-group" });
    group.createEl("summary", { text: `${label} (${items.length})` });
    for (const item of items) {
      const button = group.createEl("button", { cls: "cc-desk-group-item", text: item.title });
      button.addEventListener("click", () => void this.deps.openPath(item.path));
    }
  }

  private renderDocument(root: HTMLElement, snapshot: ProjectSnapshot, document: DocumentSections | undefined): void {
    if (!document) return;
    const section = root.createEl("section", { cls: "cc-desk-document", attr: { "aria-label": "Document" } });
    section.createEl("h3", { text: document.document.title });
    const total = document.sections.length;
    const drafted = document.sections.filter(({ state }) => state === "drafted").length;
    const changed = document.sections.filter(({ state }) => state === "changed").length;
    section.createEl("p", { cls: "cc-desk-document-progress", text: total ? `${drafted} of ${count(total, "section")} drafted${changed ? ` · ${changed} changed` : ""}` : "No tracked sections" });
    for (const issue of document.parsed.issues) section.createEl("p", { cls: "cc-research-error", text: issue });
    const actions = section.createDiv({ cls: "cc-desk-document-actions" });
    const open = actions.createEl("button", { text: "Open" });
    open.addEventListener("click", () => void this.deps.openPath(document.document.path));
    if (document.parsed.format === "v1") {
      const clean = actions.createEl("button", { cls: "mod-cta", text: "Clean up format" });
      clean.addEventListener("click", () => void this.cleanUp(document.document.path));
    }
    if (!this.draftPanel || !total) return;
    const toggle = actions.createEl("button", { text: this.sectionsOpen ? "Hide sections" : "Sections", attr: { "aria-expanded": String(this.sectionsOpen) } });
    toggle.addEventListener("click", () => { this.sectionsOpen = !this.sectionsOpen; void this.render(); });
    if (this.sectionsOpen) this.draftPanel.render(section.createDiv({ cls: "cc-desk-sections" }), snapshot, document.document, document.parsed);
  }

  private async cleanUp(path: string): Promise<void> {
    try {
      const converted = await this.repository.convertDocumentFormat(path);
      new Notice(`Cleaned up ${converted} section${converted === 1 ? "" : "s"}.`);
    } catch (error) { new Notice(sanitizeLoadError(error)); }
    await this.render();
  }

  private renderSources(root: HTMLElement, snapshot: ProjectSnapshot): void {
    const footer = root.createEl("section", { cls: "cc-desk-sources", attr: { "aria-label": "Add sources" } });
    footer.createEl("h3", { text: "Add sources" });
    const row = footer.createDiv({ cls: "cc-desk-sources-row" });
    const add = row.createEl("button", { text: "Link or file" });
    add.addEventListener("click", () => this.deps.actions.addSource(snapshot.project.path));
    if (this.deps.openDiscovery) {
      const search = row.createEl("button", { text: "Search papers" });
      search.addEventListener("click", () => this.deps.openDiscovery?.(snapshot));
    }
    const pull = row.createEl("button", { text: "Pull passages" });
    if (snapshot.sources.length) pull.addEventListener("click", () => this.deps.actions.extractEvidence(snapshot));
    else { pull.disabled = true; pull.setAttr("title", "Add a source first"); }
  }

  private renderEmpty(root: HTMLElement, projects: Array<{ path: string; title: string }>, loadError?: string): void {
    const empty = root.createEl("section", { cls: "cc-desk-empty" });
    empty.createEl("h2", { text: loadError ? "This project needs attention" : "Start a research project" });
    empty.createEl("p", { text: loadError ?? "Ask a question, add sources, and Claude helps you turn them into a backed-up argument. Everything stays as notes in your vault." });
    const controls = empty.createDiv({ cls: "cc-desk-empty-controls" });
    if (projects.length) {
      const select = controls.createEl("select", { attr: { "aria-label": "Choose research project" } });
      select.createEl("option", { text: "Choose a project", value: "" });
      for (const project of projects) select.createEl("option", { text: project.title, value: project.path });
      select.addEventListener("change", () => { if (select.value) void this.setProjectPath(select.value); });
    }
    const create = controls.createEl("button", { cls: "mod-cta", text: "New project" });
    create.addEventListener("click", () => this.deps.actions.createProject());
    if (!loadError && this.deps.startFromActiveNote) {
      const fromNote = controls.createEl("button", { text: "From active note" });
      fromNote.addEventListener("click", () => void this.deps.startFromActiveNote?.());
    }
  }
}

export class ResearchWorkbenchRedirect extends ItemView {
  getViewType(): string { return RESEARCH_WORKBENCH_VIEW_TYPE; }
  getDisplayText(): string { return "Research Desk"; }
  override getIcon(): string { return "layout-dashboard"; }
  override async onOpen(): Promise<void> { await this.leaf.setViewState({ type: RESEARCH_DESK_VIEW_TYPE, active: true }); }
}
