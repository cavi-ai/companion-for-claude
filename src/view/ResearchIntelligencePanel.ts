import type { ProjectSnapshot } from "../research/graph";
import { analyzeProjectIntelligence, type EpistemicLabel, type IntelligenceCategory, type IntelligenceFinding } from "../research/intelligence";
import type { IntelligenceCoordinator, IntelligenceNarrativeState } from "../research/intelligenceCoordinator";
import type { NarrativeResult } from "../research/intelligenceNarrative";

export interface ResearchIntelligencePanelDeps {
  coordinator: IntelligenceCoordinator;
  openPath(path: string): Promise<void>;
  rerender(): Promise<void>;
}

const CATEGORIES: Array<{ category: IntelligenceCategory; label: string }> = [
  { category: "contradiction", label: "Contradictions" },
  { category: "method-difference", label: "Method differences" },
  { category: "research-gap", label: "Research gaps" },
  { category: "evidence-quality", label: "Evidence quality" },
];

export class ResearchIntelligencePanel {
  private analyzing = false;
  private generation = 0;
  private failed: { projectPath: string; state: Extract<IntelligenceNarrativeState, { status: "failed" }> } | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ResearchIntelligencePanelDeps) {
    this.unsubscribe = deps.coordinator.subscribe(() => { void this.deps.rerender(); });
  }

  dispose(): void {
    this.unsubscribe();
    this.cancel();
  }

  cancel(): void {
    this.generation += 1;
    this.analyzing = false;
    this.deps.coordinator.cancel();
  }

  render(root: HTMLElement, snapshot: ProjectSnapshot): void {
    const findings = analyzeProjectIntelligence(snapshot);
    this.renderCategories(root, findings);
    this.renderFindings(root, findings);
    const current = this.deps.coordinator.stateFor(snapshot, findings);
    const state = current.status === "disabled"
      ? current
      : this.failed?.projectPath === snapshot.project.path ? this.failed.state : current;
    this.renderNarrative(root, snapshot, findings, state);
  }

  private renderCategories(root: HTMLElement, findings: IntelligenceFinding[]): void {
    const section = root.createDiv({ cls: "cc-intelligence-categories", attr: { "aria-label": "Intelligence finding categories" } });
    for (const { category, label } of CATEGORIES) {
      const card = section.createDiv({ cls: "cc-intelligence-category" });
      card.createSpan({ text: label });
      card.createEl("strong", { text: String(findings.filter((finding) => finding.category === category).length) });
    }
  }

  private renderFindings(root: HTMLElement, findings: IntelligenceFinding[]): void {
    root.createEl("h3", { text: "Deterministic findings" });
    if (!findings.length) root.createEl("p", { text: "No deterministic issues were found in the current structured records." });
    for (const finding of findings) {
      const card = root.createEl("article", { cls: "cc-intelligence-finding" });
      card.createEl("h4", { text: finding.title });
      const meta = card.createDiv({ cls: "cc-intelligence-meta" });
      meta.createSpan({ text: label(finding.severity) });
      meta.createSpan({ text: `${label(finding.confidence)} confidence` });
      meta.createSpan({ cls: "cc-intelligence-epistemic", text: epistemicLabel(finding.epistemicStatus) });
      card.createEl("p", { text: finding.rationale });
      card.createEl("p", { cls: "cc-intelligence-verification", text: `Verify: ${finding.verification}` });
      this.renderPaths(card, finding.paths);
    }
  }

  private renderNarrative(root: HTMLElement, snapshot: ProjectSnapshot, findings: IntelligenceFinding[], state: IntelligenceNarrativeState): void {
    root.createEl("h3", { text: "Model narrative" });
    const stale = state.status === "stale" || (state.status === "failed" && Boolean(state.previous));
    const section = root.createDiv({ cls: `cc-intelligence-narrative${stale ? " cc-intelligence-stale" : ""}` });
    if (state.status === "disabled") {
      section.createEl("p", { text: "Model analysis is disabled in settings." });
      return;
    }
    if (state.status === "not-analyzed") section.createEl("p", { text: "Analyze this project when you want a model-written briefing." });
    if (state.status === "analyzing") {
      section.createEl("p", { text: "Analyzing…" });
      this.renderProvider(section, state.providerId, state.model, state.usedFallback);
    }
    if (state.status === "stale") section.createEl("p", { text: "Out of date — analyze again to refresh this narrative." });
    if (state.status === "failed") section.createEl("p", { cls: "cc-research-error", attr: { role: "alert" }, text: `The model narrative could not be verified: ${state.message}` });
    const valid = state.status === "current" || state.status === "stale" ? state : state.status === "failed" ? state.previous : undefined;
    if (valid) {
      if (state.status === "current") section.createEl("p", { attr: { role: "status" }, text: "Analysis current" });
      this.renderProvider(section, valid.providerId, valid.model, valid.usedFallback);
      this.renderResult(section, valid.result);
    }
    if (state.status !== "analyzing") {
      const button = section.createEl("button", { text: valid ? "Analyze again" : "Analyze", attr: { "aria-label": "Analyze this project" } });
      button.disabled = this.analyzing;
      button.addEventListener("click", () => void this.analyze(button, snapshot, findings));
    }
  }

  private async analyze(button: HTMLButtonElement, snapshot: ProjectSnapshot, findings: IntelligenceFinding[]): Promise<void> {
    if (this.analyzing) return;
    this.analyzing = true;
    const generation = this.generation;
    this.failed = undefined;
    button.disabled = true;
    const pending = this.deps.coordinator.analyze(snapshot, findings);
    try {
      const state = await pending;
      if (generation === this.generation && state.status === "failed") this.failed = { projectPath: snapshot.project.path, state };
    } finally {
      if (generation === this.generation) {
        this.analyzing = false;
        await this.deps.rerender();
      }
    }
  }

  private renderProvider(root: HTMLElement, providerId: "anthropic" | "ollama", model: string, fallback: boolean): void {
    const meta = root.createDiv({ cls: "cc-intelligence-meta" });
    meta.createSpan({ text: providerId === "anthropic" ? "Anthropic" : "Ollama" });
    meta.createSpan({ text: model });
    if (fallback) meta.createSpan({ text: "Fallback" });
  }

  private renderResult(root: HTMLElement, result: NarrativeResult): void {
    root.createEl("p", { text: result.briefing });
    for (const group of result.groups) {
      root.createEl("h4", { text: group.title });
      for (const insight of group.insights) {
        const item = root.createDiv({ cls: "cc-intelligence-insight" });
        item.createSpan({ cls: "cc-intelligence-epistemic", text: epistemicLabel(insight.epistemicStatus) });
        item.createEl("p", { text: insight.text });
        this.renderPaths(item, insight.paths);
      }
    }
  }

  private renderPaths(root: HTMLElement, paths: string[]): void {
    const controls = root.createDiv({ cls: "cc-intelligence-paths" });
    for (const path of paths) {
      const button = controls.createEl("button", { text: path, attr: { "data-path": path, "aria-label": `Open ${path}` } });
      button.addEventListener("click", () => void this.deps.openPath(path));
    }
  }
}

function label(value: string): string { return `${value.charAt(0).toUpperCase()}${value.slice(1)}`; }
function epistemicLabel(value: EpistemicLabel): string {
  return value === "suggested-investigation" ? "Suggested investigation" : label(value);
}
