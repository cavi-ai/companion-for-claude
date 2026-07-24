import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { auditProject } from "../research/audit";
import { dismissDeskAction, pinDeskAction } from "../research/deskPreferences";
import { buildResearchDeskViewModel, type ResearchDeskPreferences, type ResearchDeskTarget } from "../research/deskViewModel";
import type { ProjectSnapshot } from "../research/graph";
import type { ResearchRepository } from "../research/repository";

export const RESEARCH_DESK_VIEW_TYPE = "claude-research-desk";

export interface ResearchDeskDependencies {
  preferencesFor(projectPath: string): ResearchDeskPreferences;
  updatePreferences(projectPath: string, update: (current: ResearchDeskPreferences) => ResearchDeskPreferences): void | Promise<void>;
  openWorkbench(projectPath: string, target: ResearchDeskTarget, path?: string): void | Promise<void>;
  askCompanion?(projectPath: string): void | Promise<void>;
  createProject?(): void | Promise<void>;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "The project could not be loaded.").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

export class ResearchDeskView extends ItemView {
  private projectPath: string | undefined;
  private renderSequence = 0;

  constructor(leaf: WorkspaceLeaf, private readonly repository: ResearchRepository, private readonly deps: ResearchDeskDependencies) { super(leaf); }

  getViewType(): string { return RESEARCH_DESK_VIEW_TYPE; }
  getDisplayText(): string { return "Research Desk"; }
  override getIcon(): string { return "layout-dashboard"; }
  getProjectPath(): string | undefined { return this.projectPath; }

  async setProjectPath(path?: string): Promise<void> { this.projectPath = path; await this.render(); }
  override async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const sequence = ++this.renderSequence;
    const projects = await this.repository.listProjects();
    if (sequence !== this.renderSequence) return;
    if (!this.projectPath && projects.length) this.projectPath = projects[0]?.path;
    let snapshot: ProjectSnapshot | undefined;
    let loadError: string | undefined;
    if (this.projectPath) {
      try { snapshot = await this.repository.loadProject(this.projectPath); }
      catch (error) { loadError = errorMessage(error); }
    }
    if (sequence !== this.renderSequence) return;

    let documentProgress;
    if (snapshot) {
      const document = snapshot.documents.find(({ documentKind }) => documentKind === "draft") ?? snapshot.documents.find(({ documentKind }) => documentKind === "outline");
      if (document) {
        try {
          const parsed = await this.repository.loadDraftSections(document.path);
          documentProgress = { path: document.path, title: document.title, totalSections: parsed.sections.length, completedSections: parsed.sections.filter(({ envelope, modifiedSinceReview }) => envelope.provider !== "companion" && !modifiedSinceReview).length };
        } catch { documentProgress = { path: document.path, title: document.title, totalSections: document.claims.length, completedSections: document.documentKind === "draft" ? document.claims.length : 0 }; }
      }
    }
    if (sequence !== this.renderSequence) return;

    const root = this.contentEl; root.empty(); root.addClass("cc-research-desk");
    if (!snapshot) { this.renderEmpty(root, projects, loadError); return; }
    const vm = buildResearchDeskViewModel(snapshot, auditProject(snapshot), this.deps.preferencesFor(snapshot.project.path), documentProgress);

    const header = root.createEl("header", { cls: "cc-desk-header" });
    const identity = header.createDiv({ cls: "cc-desk-identity" });
    identity.createDiv({ cls: "cc-desk-eyebrow", text: "RESEARCH DESK" });
    identity.createEl("h2", { text: vm.title });
    identity.createEl("p", { cls: "cc-desk-question", text: vm.question });
    const headerActions = header.createDiv({ cls: "cc-desk-header-actions" });
    const switcher = headerActions.createDiv({ cls: "cc-desk-switcher" });
    switcher.createEl("label", { text: "Active project", attr: { for: "cc-desk-project" } });
    const select = switcher.createEl("select", { attr: { id: "cc-desk-project", "aria-label": "Active research project" } });
    for (const project of projects) select.createEl("option", { text: project.title, value: project.path, attr: { selected: project.path === snapshot.project.path ? "selected" : null } });
    select.value = snapshot.project.path;
    select.addEventListener("change", () => void this.setProjectPath(select.value));
    if (this.deps.askCompanion) {
      const ask = headerActions.createEl("button", { cls: "cc-workspace-companion-action", text: "Ask Companion" });
      ask.addEventListener("click", () => void this.deps.askCompanion?.(snapshot.project.path));
    }

    const stage = root.createEl("section", { cls: "cc-desk-stage", attr: { "aria-label": `Research stage: ${vm.stage.current}` } });
    const stageHead = stage.createDiv({ cls: "cc-desk-section-heading" }); stageHead.createEl("h3", { text: "Research path" }); stageHead.createSpan({ text: `${vm.stage.index + 1} of ${vm.stage.total}` });
    const steps = stage.createDiv({ cls: "cc-desk-stage-track" });
    for (const step of vm.stage.steps) { const item = steps.createDiv({ cls: `cc-desk-stage-step is-${step.state}` }); item.createSpan({ cls: "cc-desk-stage-dot" }); item.createSpan({ text: step.label }); }

    if (vm.nextAction) {
      const next = root.createEl("section", { cls: `cc-desk-next is-${vm.nextAction.tone}`, attr: { "aria-labelledby": "cc-desk-next-title", "data-pinned": String(Boolean(vm.nextAction.pinned)) } });
      const meta = next.createDiv({ cls: "cc-desk-next-meta" }); meta.createSpan({ text: vm.nextAction.pinned ? "PINNED PRIORITY" : "NEXT BEST ACTION" }); meta.createSpan({ text: `Priority ${vm.nextAction.priority + 1}` });
      next.createEl("h3", { attr: { id: "cc-desk-next-title" }, text: vm.nextAction.label });
      next.createEl("p", { cls: "cc-desk-next-reason", text: vm.nextAction.reason });
      const controls = next.createDiv({ cls: "cc-desk-next-controls" });
      const start = controls.createEl("button", { cls: "mod-cta", text: "Start this task" });
      start.addEventListener("click", () => void this.deps.openWorkbench(snapshot.project.path, vm.nextAction!.target, vm.nextAction!.path));
      const pin = controls.createEl("button", { text: vm.nextAction.pinned ? "Unpin" : "Pin" });
      pin.addEventListener("click", () => void this.updatePreferences(snapshot.project.path, (current) => pinDeskAction(current, vm.nextAction!.id)));
      const dismiss = controls.createEl("button", { text: "Dismiss" });
      dismiss.addEventListener("click", () => void this.updatePreferences(snapshot.project.path, (current) => dismissDeskAction(current, vm.nextAction!.id)));
      const choose = controls.createEl("button", { text: "Choose another" });
      choose.addEventListener("click", () => root.querySelector<HTMLElement>(".cc-desk-attention-row")?.focus());
    }

    const grid = root.createDiv({ cls: "cc-desk-grid" });
    const document = grid.createEl("section", { cls: "cc-desk-card cc-desk-document" });
    document.createDiv({ cls: "cc-desk-card-label", text: "ACTIVE WORK" });
    if (vm.activeDocument) {
      document.createEl("h3", { text: vm.activeDocument.title });
      document.createEl("p", { text: `${vm.activeDocument.completedSections} of ${vm.activeDocument.totalSections} sections grounded` });
      const progress = document.createDiv({ cls: "cc-desk-document-progress", attr: { role: "progressbar", "aria-label": "Grounded section progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(vm.activeDocument.progress) } });
      progress.createDiv({ cls: "cc-desk-progress-fill", attr: { style: `width:${vm.activeDocument.progress}%` } });
      const continueButton = document.createEl("button", { text: "Continue document" }); continueButton.addEventListener("click", () => void this.deps.openWorkbench(snapshot.project.path, "Draft", vm.activeDocument?.path));
    } else { document.createEl("h3", { text: "No active document" }); document.createEl("p", { text: "Build an evidence-backed outline when the claims are ready." }); }

    const attention = grid.createEl("section", { cls: "cc-desk-card cc-desk-attention" });
    attention.createDiv({ cls: "cc-desk-card-label", text: "NEEDS ATTENTION" }); attention.createEl("h3", { text: vm.attention.length ? `${vm.attention.length} focused item${vm.attention.length === 1 ? "" : "s"}` : "Nothing is blocking you" });
    if (!vm.attention.length) attention.createEl("p", { text: "The current project is clear for its next stage." });
    for (const item of vm.attention) { const row = attention.createEl("button", { cls: `cc-desk-attention-row is-${item.tone}` }); row.createSpan({ text: item.label }); row.createSpan({ text: "Open →" }); row.addEventListener("click", () => void this.deps.openWorkbench(snapshot.project.path, item.target, item.path)); }

    const metrics = root.createEl("section", { cls: "cc-desk-metrics", attr: { "aria-label": "Project record counts" } });
    for (const [label, count, target] of [["Sources", vm.counts.sources, "Sources"], ["Evidence", vm.counts.evidence, "Evidence"], ["Claims", vm.counts.claims, "Claims"], ["Open questions", vm.counts.openQuestions, "Overview"]] as const) {
      const metric = metrics.createEl("button", { cls: "cc-desk-metric", attr: { "aria-label": `Open ${label.toLowerCase()}` } }); metric.createEl("strong", { text: String(count) }); metric.createSpan({ text: label }); metric.addEventListener("click", () => void this.deps.openWorkbench(snapshot.project.path, target));
    }

    const quick = root.createEl("section", { cls: "cc-desk-quick" }); quick.createEl("h3", { text: "Quick actions" });
    const quickRow = quick.createDiv({ cls: "cc-desk-quick-row" });
    for (const [label, target] of [["Capture source", "Sources"], ["Review evidence", "Evidence"], ["Develop claim", "Claims"], ["Continue draft", "Draft"], ["Run audit", "Audit"]] as const) { const button = quickRow.createEl("button", { text: label }); button.addEventListener("click", () => void this.deps.openWorkbench(snapshot.project.path, target)); }
  }

  private renderEmpty(root: HTMLElement, projects: Array<{ path: string; title: string }>, loadError?: string): void {
    const empty = root.createEl("section", { cls: "cc-desk-empty" }); empty.createDiv({ cls: "cc-desk-eyebrow", text: "RESEARCH DESK" }); empty.createEl("h2", { text: loadError ? "This project needs attention" : "Start your research system" });
    empty.createEl("p", { text: loadError ?? "Create a project or choose an existing one. The Desk will guide sources, evidence, claims, writing, and assurance without hiding the underlying notes." });
    const controls = empty.createDiv({ cls: "cc-desk-empty-controls" });
    if (projects.length) { const select = controls.createEl("select", { attr: { "aria-label": "Choose research project" } }); select.createEl("option", { text: "Choose a project", value: "" }); for (const project of projects) select.createEl("option", { text: project.title, value: project.path }); select.addEventListener("change", () => { if (select.value) void this.setProjectPath(select.value); }); }
    const create = controls.createEl("button", { cls: "mod-cta", text: "Create project" }); create.addEventListener("click", () => this.deps.createProject ? void this.deps.createProject() : new Notice("Use the Research Workbench to create a project."));
  }

  private async updatePreferences(path: string, update: (current: ResearchDeskPreferences) => ResearchDeskPreferences): Promise<void> { await this.deps.updatePreferences(path, update); await this.render(); }
}
