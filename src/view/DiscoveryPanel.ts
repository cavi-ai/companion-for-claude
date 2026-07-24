import type { DiscoveryCoordinator, DiscoveryState, ImportCandidateOutcome } from "../discovery/coordinator";
import type { RankedCandidate, RankingFactors } from "../discovery/rank";
import type { DiscoveryCandidate, FieldProvenance } from "../discovery/types";
import type { ProjectSnapshot } from "../research/graph";
import { safeWebUrl } from "../discovery/safeUrl";

let nextPanelId = 0;

export interface DiscoveryPanelDeps {
  coordinator: DiscoveryCoordinator;
  openPath(path: string): Promise<void>;
  rerender(): Promise<void>;
}

export class DiscoveryPanel {
  private readonly queryInputId = `cc-discovery-query-${++nextPanelId}`;
  private query = "";
  private queryProject = "";
  private selected = new Set<string>();
  private expanded = new Set<string>();
  private outcomes = new Map<string, ImportCandidateOutcome>();
  private busy = new Set<string>();
  private importing = new Set<string>();
  private generation = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: DiscoveryPanelDeps) { this.subscribe(); }

  dispose(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.busy.clear();
    this.importing.clear();
    this.deps.coordinator.cancel();
  }

  cancel(): void { this.generation += 1; this.busy.clear(); this.importing.clear(); this.deps.coordinator.cancel(); }

  render(root: HTMLElement, snapshot: ProjectSnapshot): void {
    const state = this.deps.coordinator.stateFor(snapshot);
    if (this.queryProject !== snapshot.project.path) {
      this.queryProject = snapshot.project.path;
      this.query = state.query.text;
      this.selected.clear(); this.expanded.clear(); this.outcomes.clear();
    }
    if (state.status === "disabled") {
      const status = root.createDiv({ cls: "cc-discovery-status is-disabled", attr: { role: "status" } });
      status.createEl("h3", { text: "Scholarly discovery is off" });
      status.createEl("p", { text: "Enable it in Companion settings to search OpenAlex, Crossref, and arXiv from this project." });
      return;
    }
    const setup = root.createDiv({ cls: "cc-discovery-setup" });
    setup.createEl("label", { text: "Discovery query", attr: { for: this.queryInputId } });
    const input = setup.createEl("input", { attr: { id: this.queryInputId, type: "search" } });
    input.value = this.query;
    input.addEventListener("input", () => { this.query = input.value; });
    this.action(setup, "Search", "search", () => this.deps.coordinator.search(snapshot, this.query));
    this.renderState(root, snapshot, state);
  }

  private subscribe(): void {
    this.unsubscribe = this.deps.coordinator.subscribe(() => { if (this.unsubscribe) void this.deps.rerender(); });
  }

  private renderState(root: HTMLElement, snapshot: ProjectSnapshot, state: DiscoveryState): void {
    const status = root.createDiv({ cls: "cc-discovery-status", attr: { role: state.status === "failed" ? "alert" : "status" } });
    if (state.status === "disabled") { status.setText("Enable scholarly discovery in Companion settings."); return; }
    if (state.status === "idle") status.setText("Ready to search. No external request is made until Search is pressed.");
    if (state.status === "searching") status.setText("Searching… Previous results remain available.");
    if (state.status === "ready") status.setText("Results ready.");
    if (state.status === "stale") status.setText("Out of date — search again to refresh these results.");
    if (state.status === "failed") status.setText(state.message);
    if ([...this.busy].some((key) => key === "rerank")) status.createDiv({ text: "Reranking… Deterministic order and factors remain visible." });
    if (this.importing.size) status.createDiv({ text: "Importing…" });
    const valid = state.status === "ready" || state.status === "stale" ? state : state.status === "searching" || state.status === "failed" ? state.previous : undefined;
    if (!valid) return;
    if (valid.partialAdapters.length) status.createDiv({ text: `Partial metadata: ${valid.partialAdapters.map(label).join(", ")}` });
    if (valid.providerId && valid.model) status.createDiv({ text: `${providerLabel(valid.providerId)} · ${valid.model}${valid.usedFallback ? " · Fallback" : ""}` });
    if (valid.ranked.length) this.action(root, "Rerank with model", "rerank", () => this.deps.coordinator.rerank(snapshot));
    const selectedIds = [...this.selected];
    const importSelected = this.action(root, "Import selected", "import-selected", () => this.deps.coordinator.importCandidates(snapshot, selectedIds), selectedIds, (outcomes) => this.record(outcomes));
    if (!this.selected.size) importSelected.disabled = true;
    const modelById = new Map(valid.modelRanked?.map((item) => [item.candidate.id, item]));
    for (const ranked of valid.ranked) this.renderCandidate(root, snapshot, ranked, modelById.get(ranked.candidate.id));
  }

  private renderCandidate(root: HTMLElement, snapshot: ProjectSnapshot, ranked: RankedCandidate, model?: { modelRank: number; reason: string }): void {
    const candidate = ranked.candidate;
    const card = root.createEl("article", { cls: "cc-discovery-candidate" });
    const select = card.createEl("input", { attr: { type: "checkbox", "aria-label": `Select ${candidate.title}` } });
    select.checked = this.selected.has(candidate.id);
    select.addEventListener("change", () => { if (select.checked) this.selected.add(candidate.id); else this.selected.delete(candidate.id); void this.deps.rerender(); });
    card.createEl("h3", { text: candidate.title });
    card.createEl("p", { cls: "cc-discovery-byline", text: candidate.authors.join(", ") || "Unknown authors" });
    card.createEl("p", { text: [candidate.published, candidate.publication].filter(Boolean).join(" · ") || "Publication details unavailable" });
    if (candidate.abstract) card.createEl("p", { cls: "cc-discovery-abstract", text: candidate.abstract.slice(0, 600) });
    card.createEl("p", { text: identifiers(candidate) || "No additional identifiers" });
    const openAccessUrl = safeWebUrl(candidate.openAccessUrl);
    if (openAccessUrl) card.createEl("a", { text: "Open access link", attr: { href: openAccessUrl, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open external article: ${candidate.title}` } });
    if (candidate.existingSourcePath) card.createEl("p", { text: `Existing source: ${candidate.existingSourcePath}` });
    if (candidate.relationship) card.createEl("p", { text: `Seed ${candidate.relationship.seedId} · ${directionLabel(candidate.relationship.direction)}` });
    card.createEl("p", { text: `Deterministic rank ${ranked.deterministicRank} · Score ${format(ranked.totalScore)}` });
    this.renderFactors(card, ranked.factors);
    if (model) card.createEl("p", { text: `Model rank ${model.modelRank}: ${model.reason}` });
    const detail = card.createEl("button", { text: this.expanded.has(candidate.id) ? "Hide details" : "Show details", attr: { "aria-expanded": String(this.expanded.has(candidate.id)) } });
    detail.addEventListener("click", () => { if (this.expanded.has(candidate.id)) this.expanded.delete(candidate.id); else this.expanded.add(candidate.id); void this.deps.rerender(); });
    // Keep trust metadata in the DOM for assistive/search use; expansion controls its visual presentation.
    this.renderTrust(card, candidate, this.expanded.has(candidate.id));
    const actions = card.createDiv({ cls: "cc-discovery-actions" });
    this.action(actions, "References", `expand:${candidate.id}:references`, () => this.deps.coordinator.expand(snapshot, candidate.id, "references"));
    this.action(actions, "Cited by", `expand:${candidate.id}:cited-by`, () => this.deps.coordinator.expand(snapshot, candidate.id, "cited-by"));
    this.action(actions, "Import", `import:${candidate.id}`, () => this.deps.coordinator.importCandidates(snapshot, [candidate.id]), [candidate.id], (outcomes) => this.record(outcomes));
    if (candidate.existingSourcePath) this.pathButton(actions, "Open source", candidate.existingSourcePath);
    this.action(actions, "Dismiss", `dismiss:${candidate.id}`, async () => { this.deps.coordinator.dismiss(candidate.id); });
    const outcome = this.outcomes.get(candidate.id);
    if (outcome) card.createEl("p", { cls: outcome.status === "failed" ? "cc-research-error" : "cc-discovery-outcome", attr: { role: outcome.status === "failed" ? "alert" : "status" }, text: outcomeText(outcome) });
  }

  private renderFactors(root: HTMLElement, factors: RankingFactors): void {
    const list = root.createEl("dl", { cls: "cc-discovery-factors", attr: { "aria-label": "Deterministic ranking factors" } });
    for (const name of Object.keys(factors) as Array<keyof RankingFactors>) { list.createEl("dt", { text: factorLabel(name) }); list.createEl("dd", { text: format(factors[name]) }); }
  }

  private renderTrust(root: HTMLElement, candidate: DiscoveryCandidate, visible: boolean): void {
    const detail = root.createDiv({ cls: `cc-discovery-detail${visible ? " is-expanded" : ""}`, attr: { "aria-hidden": String(!visible) } });
    detail.createEl("h4", { text: "Provenance" });
    for (const [field, values] of Object.entries(candidate.provenance)) for (const value of values) detail.createEl("p", { text: `${factorLabel(field)} — ${provenance(value)}` });
    detail.createEl("h4", { text: "Disagreements" });
    if (!candidate.disagreements.length) detail.createEl("p", { text: "No metadata disagreements." });
    for (const disagreement of candidate.disagreements) detail.createEl("p", { text: `${factorLabel(disagreement.field)}: ${disagreement.values.map(provenance).join("; ")}` });
  }

  private action<T>(root: HTMLElement, labelText: string, key: string, operation: () => Promise<T>, candidateIds: readonly string[] = [], complete?: (result: T) => void): HTMLButtonElement {
    const overlapsImport = candidateIds.some((id) => this.importing.has(id));
    const button = root.createEl("button", { text: labelText }); button.disabled = this.busy.has(key) || overlapsImport;
    button.addEventListener("click", () => {
      if (this.busy.has(key) || candidateIds.some((id) => this.importing.has(id))) return;
      this.busy.add(key); for (const id of candidateIds) this.importing.add(id); button.disabled = true;
      const generation = this.generation;
      const pending = operation();
      void (async () => {
        await this.deps.rerender();
        const result = await pending;
        if (generation === this.generation) complete?.(result);
      })().finally(() => {
        if (generation === this.generation) {
          this.busy.delete(key); for (const id of candidateIds) this.importing.delete(id);
          void this.deps.rerender();
        }
      });
    });
    return button;
  }

  private pathButton(root: HTMLElement, labelText: string, path: string): void {
    const button = root.createEl("button", { text: labelText, attr: { "aria-label": `${labelText}: ${path}` } });
    button.addEventListener("click", () => void this.deps.openPath(path));
  }

  private record(outcomes: ImportCandidateOutcome[]): void { for (const outcome of outcomes) this.outcomes.set(outcome.candidateId, outcome); }
}

function format(value: number): string { return value.toFixed(2); }
function label(value: string): string { return value === "openalex" ? "OpenAlex" : value === "crossref" ? "Crossref" : "arXiv"; }
function providerLabel(value: string): string { return value === "anthropic" ? "Anthropic" : "Ollama"; }
function directionLabel(value: string): string { return value === "cited-by" ? "Cited by" : "References"; }
function factorLabel(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase()); }
function provenance(value: FieldProvenance): string { return `${label(value.adapter)} ${value.externalId}: ${Array.isArray(value.value) ? value.value.join(", ") : value.value}`; }
function identifiers(candidate: DiscoveryCandidate): string { return [["DOI", candidate.doi], ["arXiv", candidate.arxivId], ["OpenAlex", candidate.openAlexId]].filter((pair) => pair[1]).map((pair) => `${pair[0]} ${pair[1]}`).join(" · "); }
function outcomeText(outcome: ImportCandidateOutcome): string {
  if (outcome.status === "created") return "Created";
  if (outcome.status === "duplicate") return "Duplicate — existing source retained";
  return `Import failed: ${"message" in outcome ? outcome.message : "The source could not be imported."}`;
}
