import type { DraftCoordinator, DraftPreview } from "../research/draftCoordinator";
import type { RevisionCoordinator, RevisionPreview } from "../research/revisionCoordinator";
import type { RevisionIntent } from "../research/revisionPolicy";
import type { DraftSectionParseResult, ParsedDraftSection } from "../research/draftSections";
import type { ProjectSnapshot } from "../research/graph";
import { buildDraftGrounding, groundingClaimFingerprint } from "../research/draftGrounding";
import type { ResearchRepository } from "../research/repository";
import type { ResearchDocumentRecord } from "../research/types";
import { planEdits } from "../edit/diff";

export interface ResearchDraftPanelDeps {
  coordinator: DraftCoordinator;
  revisionCoordinator?: RevisionCoordinator;
  repository: ResearchRepository;
  rerender(): void | Promise<void>;
}

export function safeDraftError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Section draft failed.";
  return raw.replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|Bearer\s+\S+|api[_-]?key\s*[=:]\s*\S+)/gi, "[redacted]").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "Section draft failed.";
}

export class ResearchDraftPanel {
  private readonly previews = new Map<string, DraftPreview>();
  private readonly errors = new Map<string, string>();
  private readonly revisionPreviews = new Map<string, RevisionPreview>();
  private readonly revisionForms = new Map<string, { open: boolean; intent: RevisionIntent; customInstruction: string }>();
  private active: AbortController | undefined;
  private scope = "";

  constructor(private readonly deps: ResearchDraftPanelDeps) {}

  dispose(): void { this.active?.abort(); this.active = undefined; }

  render(root: HTMLElement, snapshot: ProjectSnapshot, document: ResearchDocumentRecord | undefined, parsed: DraftSectionParseResult | undefined): void {
    const scope = `${snapshot.project.path}\0${document?.path ?? ""}`;
    if (scope !== this.scope) {
      this.active?.abort(); this.previews.clear(); this.errors.clear(); this.revisionPreviews.clear(); this.revisionForms.clear(); this.scope = scope;
    }
    root.createEl("h3", { text: "Section drafting" });
    root.createEl("p", { text: "Draft one claim-grounded section at a time. Previewing never writes to the vault." });
    if (!document) { root.createEl("p", { text: "Build an evidence-backed outline before drafting." }); return; }
    if (!parsed) { root.createEl("p", { cls: "cc-research-error", text: "The document sections could not be loaded." }); return; }
    for (const issue of parsed.issues) root.createEl("p", { cls: "cc-research-error", text: issue });
    if (!parsed.sections.length) { root.createEl("p", { text: "This document has no managed sections. Regenerate the evidence-backed outline to make its sections draftable." }); return; }
    for (const section of parsed.sections) this.renderSection(root, snapshot, document, section);
  }

  private renderSection(root: HTMLElement, snapshot: ProjectSnapshot, document: ResearchDocumentRecord, section: ParsedDraftSection): void {
    const card = root.createEl("article", { cls: "cc-draft-section" });
    const heading = /^##\s+(.+)$/m.exec(section.markdown)?.[1] ?? section.envelope.id;
    card.createEl("h4", { text: heading });
    const evidenceDrift = section.envelope.provider !== "companion" && this.evidenceChanged(snapshot, section);
    const stale = section.modifiedSinceReview || evidenceDrift;
    const status = section.modifiedSinceReview ? "Modified since review" : evidenceDrift ? "Evidence changed since review" : section.envelope.provider === "companion" ? "Ready to draft" : "Accepted draft";
    card.createEl("p", { cls: `cc-draft-status${stale ? " is-stale" : ""}`, text: status });
    card.createEl("p", { text: `${section.envelope.claimPaths.length} claim · ${section.envelope.evidence.length} evidence record${section.envelope.evidence.length === 1 ? "" : "s"}` });
    const error = this.errors.get(section.envelope.id);
    if (error) card.createEl("p", { cls: "cc-research-error", attr: { role: "alert" }, text: error });
    const preview = this.previews.get(section.envelope.id);
    if (!preview) {
      const revisionPreview = this.revisionPreviews.get(section.envelope.id);
      if (revisionPreview) { this.renderRevisionPreview(card, snapshot, document, section, revisionPreview); return; }
      if (section.envelope.provider !== "companion") {
        if (!stale) this.renderRevisionControls(card, snapshot, section);
        return;
      }
      const button = card.createEl("button", { text: "Preview draft" });
      button.addEventListener("click", () => void this.preview(snapshot, section));
      return;
    }
    card.createEl("p", { cls: "cc-draft-provider", text: `${preview.envelope.provider} · ${preview.envelope.model}` });
    card.createEl("pre", { cls: "cc-draft-preview", text: preview.response.markdown });
    const diff = card.createDiv({ cls: "cc-draft-diff", attr: { "aria-label": "Section before and after diff" } });
    const hunk = planEdits(section.markdown, [{ old_str: section.markdown, new_str: preview.response.markdown }]).hunks[0];
    if (hunk) {
      const lines = diff.createEl("pre", { cls: "cc-diff-lines" });
      for (const line of hunk.lines) lines.createDiv({ cls: `cc-diff-line is-${line.kind}`, text: `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}` });
    }
    card.createEl("p", { text: `${preview.response.support.length} supported passage${preview.response.support.length === 1 ? "" : "s"} · ${preview.response.gaps.length} unresolved gap${preview.response.gaps.length === 1 ? "" : "s"}` });
    const support = card.createEl("details", { cls: "cc-draft-support" });
    support.createEl("summary", { text: "Inspect support manifest" });
    for (const entry of preview.response.support) {
      support.createEl("p", { text: entry.passage });
      support.createEl("p", { cls: "cc-draft-support-paths", text: `Claim: ${entry.claimPath} · Evidence: ${entry.evidencePaths.join(", ")} · Citations: ${entry.citationKeys.map((key) => `[@${key}]`).join(", ")}` });
    }
    if (preview.response.gaps.length) {
      support.createEl("strong", { text: "Unresolved gaps" });
      for (const gap of preview.response.gaps) support.createEl("p", { text: gap });
    }
    const accept = card.createEl("button", { text: "Accept section" });
    accept.addEventListener("click", () => void this.accept(snapshot.project.path, document.path, preview));
    const discard = card.createEl("button", { text: "Discard preview" });
    discard.addEventListener("click", () => { this.previews.delete(section.envelope.id); this.errors.delete(section.envelope.id); void this.deps.rerender(); });
  }

  private renderRevisionControls(card: HTMLElement, snapshot: ProjectSnapshot, section: ParsedDraftSection): void {
    if (!this.deps.revisionCoordinator) return;
    const form = this.revisionForms.get(section.envelope.id) ?? { open: false, intent: "clarity" as RevisionIntent, customInstruction: "" };
    if (!form.open) {
      const open = card.createEl("button", { text: "Revise section" });
      open.addEventListener("click", () => { this.revisionForms.set(section.envelope.id, { ...form, open: true }); void this.deps.rerender(); });
      return;
    }
    const label = card.createEl("label", { text: "Revision intent" });
    const select = label.createEl("select", { cls: "cc-revision-intent" });
    const intents: Array<[RevisionIntent, string]> = [["clarity", "Clarity"], ["concision", "Concision"], ["audience", "Audience fit"], ["structure", "Structure"], ["skeptical", "Skeptical strengthening"], ["custom", "Custom"]];
    for (const [value, text] of intents) select.createEl("option", { text, attr: { value } });
    select.value = form.intent;
    select.addEventListener("change", () => { form.intent = select.value as RevisionIntent; this.revisionForms.set(section.envelope.id, form); });
    const instruction = card.createEl("textarea", { cls: "cc-revision-instruction", attr: { placeholder: "Optional custom instruction" } });
    instruction.value = form.customInstruction;
    instruction.addEventListener("input", () => { form.customInstruction = instruction.value; this.revisionForms.set(section.envelope.id, form); });
    const preview = card.createEl("button", { text: "Preview revision" });
    preview.addEventListener("click", () => void this.previewRevision(snapshot, section, form));
    const cancel = card.createEl("button", { text: "Cancel revision" });
    cancel.addEventListener("click", () => { this.revisionForms.delete(section.envelope.id); void this.deps.rerender(); });
  }

  private renderRevisionPreview(card: HTMLElement, snapshot: ProjectSnapshot, document: ResearchDocumentRecord, section: ParsedDraftSection, preview: RevisionPreview): void {
    card.createEl("p", { cls: "cc-draft-provider", text: `${preview.request.intent}${preview.request.customInstruction ? ` · ${preview.request.customInstruction}` : ""} · ${preview.envelope.provider} · ${preview.envelope.model}` });
    card.createEl("pre", { cls: "cc-draft-preview", text: preview.response.markdown });
    const diff = card.createDiv({ cls: "cc-draft-diff", attr: { "aria-label": "Section revision before and after diff" } });
    const hunk = planEdits(section.markdown, [{ old_str: section.markdown, new_str: preview.response.markdown }]).hunks[0];
    if (hunk) { const lines = diff.createEl("pre", { cls: "cc-diff-lines" }); for (const line of hunk.lines) lines.createDiv({ cls: `cc-diff-line is-${line.kind}`, text: `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}` }); }
    const report = card.createEl("details", { cls: "cc-revision-report" });
    report.createEl("summary", { text: "Inspect preservation report" });
    report.createEl("p", { text: `${preview.response.claimPreservation.length} preserved claim · ${preview.response.support.length} supported passage${preview.response.support.length === 1 ? "" : "s"}` });
    for (const warning of preview.response.warnings) report.createEl("p", { cls: "cc-revision-warning", text: warning });
    for (const violation of preview.response.violations) report.createEl("p", { cls: "cc-research-error", text: violation });
    if (preview.response.canAccept) {
      const accept = card.createEl("button", { text: "Accept revision" });
      accept.addEventListener("click", () => void this.acceptRevision(snapshot.project.path, document.path, preview));
    }
    const discard = card.createEl("button", { text: "Discard revision" });
    discard.addEventListener("click", () => { this.revisionPreviews.delete(section.envelope.id); this.revisionForms.delete(section.envelope.id); this.errors.delete(section.envelope.id); void this.deps.rerender(); });
  }

  private async preview(snapshot: ProjectSnapshot, section: ParsedDraftSection): Promise<void> {
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    this.errors.delete(section.envelope.id);
    try {
      const preview = await this.deps.coordinator.preview(snapshot, section, controller.signal);
      if (!controller.signal.aborted) this.previews.set(section.envelope.id, preview);
    } catch (error) {
      if (!controller.signal.aborted) this.errors.set(section.envelope.id, safeDraftError(error));
    } finally {
      if (this.active === controller) this.active = undefined;
      if (!controller.signal.aborted) await this.deps.rerender();
    }
  }

  private async accept(projectPath: string, documentPath: string, preview: DraftPreview): Promise<void> {
    this.errors.delete(preview.section.envelope.id);
    try {
      const current = await this.deps.repository.loadProject(projectPath);
      const packet = buildDraftGrounding(current, preview.packet.claim.path);
      await this.deps.repository.acceptDraftSection({ documentPath, preview: preview.section, envelope: preview.envelope, markdown: preview.response.markdown, currentEvidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), currentClaimFingerprint: groundingClaimFingerprint(packet) });
      this.previews.delete(preview.section.envelope.id);
    } catch (error) {
      this.errors.set(preview.section.envelope.id, safeDraftError(error));
    }
    await this.deps.rerender();
  }

  private async previewRevision(snapshot: ProjectSnapshot, section: ParsedDraftSection, form: { intent: RevisionIntent; customInstruction: string }): Promise<void> {
    if (!this.deps.revisionCoordinator) return;
    this.active?.abort(); const controller = new AbortController(); this.active = controller; this.errors.delete(section.envelope.id);
    try {
      const request = { intent: form.intent, ...(form.customInstruction.trim() ? { customInstruction: form.customInstruction.trim() } : {}) };
      const preview = await this.deps.revisionCoordinator.preview(snapshot, section, request, controller.signal);
      if (!controller.signal.aborted) this.revisionPreviews.set(section.envelope.id, preview);
    } catch (error) { if (!controller.signal.aborted) this.errors.set(section.envelope.id, safeDraftError(error)); }
    finally { if (this.active === controller) this.active = undefined; if (!controller.signal.aborted) await this.deps.rerender(); }
  }

  private async acceptRevision(projectPath: string, documentPath: string, preview: RevisionPreview): Promise<void> {
    this.errors.delete(preview.section.envelope.id);
    try {
      const current = await this.deps.repository.loadProject(projectPath); const packet = buildDraftGrounding(current, preview.packet.claim.path);
      await this.deps.repository.acceptRevisionSection({ documentPath, preview: preview.section, envelope: preview.envelope, markdown: preview.response.markdown, currentEvidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), currentClaimFingerprint: groundingClaimFingerprint(packet), packet, request: preview.request, response: preview.response });
      this.revisionPreviews.delete(preview.section.envelope.id); this.revisionForms.delete(preview.section.envelope.id);
    } catch (error) { this.errors.set(preview.section.envelope.id, safeDraftError(error)); }
    await this.deps.rerender();
  }

  private evidenceChanged(snapshot: ProjectSnapshot, section: ParsedDraftSection): boolean {
    try {
      const claimPath = section.envelope.claimPaths[0];
      if (!claimPath) return true;
      const packet = buildDraftGrounding(snapshot, claimPath);
      return groundingClaimFingerprint(packet) !== section.envelope.claimFingerprint || JSON.stringify(packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint }))) !== JSON.stringify(section.envelope.evidence);
    } catch { return true; }
  }
}
