import type { DraftCoordinator, DraftPreview } from "../research/draftCoordinator";
import type { RevisionCoordinator, RevisionPreview } from "../research/revisionCoordinator";
import type { RevisionIntent } from "../research/revisionPolicy";
import type { DraftSectionParseResult, ParsedDraftSection } from "../research/draftSections";
import { isOutlineEnvelope, isReviewedClaimFallback } from "../research/draftSections";
import type { ProjectSnapshot } from "../research/graph";
import { evidenceChanged } from "../research/sectionStatus";
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

interface SectionWork {
  previews: Map<string, DraftPreview>;
  errors: Map<string, string>;
  revisionPreviews: Map<string, RevisionPreview>;
  revisionForms: Map<string, { open: boolean; intent: RevisionIntent; customInstruction: string }>;
}

export class ResearchDraftPanel {
  private readonly scopes = new Map<string, SectionWork>();
  private active: { controller: AbortController; sectionId: string; kind: "draft" | "revision" } | undefined;
  private scope = "";

  constructor(private readonly deps: ResearchDraftPanelDeps) {}

  dispose(): void { this.active?.controller.abort(); this.active = undefined; }

  private stateFor(scope = this.scope): SectionWork {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { previews: new Map(), errors: new Map(), revisionPreviews: new Map(), revisionForms: new Map() };
      this.scopes.set(scope, state);
    }
    return state;
  }

  render(root: HTMLElement, snapshot: ProjectSnapshot, document: ResearchDocumentRecord | undefined, parsed: DraftSectionParseResult | undefined): void {
    const scope = `${snapshot.project.path}\0${document?.path ?? ""}`;
    if (scope !== this.scope) {
      this.dispose(); this.scope = scope;
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
    const state = this.stateFor();
    const card = root.createEl("article", { cls: "cc-draft-section" });
    const heading = section.heading;
    card.createEl("h4", { text: heading });
    const outline = isOutlineEnvelope(section.envelope);
    const evidenceDrift = !outline && evidenceChanged(snapshot, section);
    const stale = section.modifiedSinceReview || evidenceDrift;
    const pending = this.active?.sectionId === section.envelope.id ? this.active : undefined;
    const preview = state.previews.get(section.envelope.id);
    let status = outline ? "Ready to draft" : isReviewedClaimFallback(section.envelope) ? "Accepted fallback" : "Accepted draft";
    if (preview) status = "Draft preview ready";
    if (evidenceDrift) status = "Evidence changed since review";
    if (section.modifiedSinceReview) status = "Modified since review";
    if (pending) status = pending.kind === "draft" ? "Drafting section…" : "Preparing revision…";
    card.createEl("p", { cls: `cc-draft-status${stale ? " is-stale" : ""}`, attr: { role: "status" }, text: status });
    card.createEl("p", { text: `${section.envelope.claimPaths.length} claim · ${section.envelope.evidence.length} evidence record${section.envelope.evidence.length === 1 ? "" : "s"}` });
    if (pending) {
      const cancel = card.createEl("button", { text: pending.kind === "draft" ? "Cancel draft" : "Cancel revision" });
      cancel.addEventListener("click", () => { this.dispose(); void this.deps.rerender(); });
      return;
    }
    const error = state.errors.get(section.envelope.id);
    if (error) card.createEl("p", { cls: "cc-research-error", attr: { role: "alert" }, text: error });
    if (!preview) {
      const revisionPreview = state.revisionPreviews.get(section.envelope.id);
      if (revisionPreview) { this.renderRevisionPreview(card, snapshot, document, section, revisionPreview); return; }
      if (!outline) {
        if (!stale) this.renderRevisionControls(card, snapshot, section);
        return;
      }
      const button = card.createEl("button", { text: "Preview draft" });
      button.disabled = Boolean(this.active);
      button.addEventListener("click", () => void this.preview(snapshot, section));
      return;
    }
    if (isReviewedClaimFallback(preview.envelope)) card.createEl("p", { cls: "cc-draft-fallback", attr: { role: "status" }, text: "The model did not return a usable draft. Companion generated this minimal version from the reviewed claim." });
    card.createEl("p", { cls: "cc-draft-provider", text: isReviewedClaimFallback(preview.envelope) ? "Companion · reviewed-claim fallback" : `${preview.envelope.provider} · ${preview.envelope.model}` });
    card.createEl("pre", { cls: "cc-draft-preview", text: preview.response.markdown });
    this.renderDiff(card, section.markdown, preview.response.markdown, "Section before and after diff");
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
    discard.addEventListener("click", () => { state.previews.delete(section.envelope.id); state.errors.delete(section.envelope.id); void this.deps.rerender(); });
  }

  private renderRevisionControls(card: HTMLElement, snapshot: ProjectSnapshot, section: ParsedDraftSection): void {
    const state = this.stateFor();
    if (!this.deps.revisionCoordinator) return;
    const form = state.revisionForms.get(section.envelope.id) ?? { open: false, intent: "clarity" as RevisionIntent, customInstruction: "" };
    if (!form.open) {
      const open = card.createEl("button", { text: "Revise section" });
      open.addEventListener("click", () => { state.revisionForms.set(section.envelope.id, { ...form, open: true }); void this.deps.rerender(); });
      return;
    }
    const label = card.createEl("label", { text: "Revision intent" });
    const select = label.createEl("select", { cls: "cc-revision-intent" });
    const intents: Array<[RevisionIntent, string]> = [["clarity", "Clarity"], ["concision", "Concision"], ["audience", "Audience fit"], ["structure", "Structure"], ["skeptical", "Skeptical strengthening"], ["custom", "Custom"]];
    for (const [value, text] of intents) select.createEl("option", { text, attr: { value } });
    select.value = form.intent;
    select.addEventListener("change", () => { form.intent = select.value as RevisionIntent; state.revisionForms.set(section.envelope.id, form); });
    const instruction = card.createEl("textarea", { cls: "cc-revision-instruction", attr: { placeholder: "Optional custom instruction" } });
    instruction.value = form.customInstruction;
    instruction.addEventListener("input", () => { form.customInstruction = instruction.value; state.revisionForms.set(section.envelope.id, form); });
    const preview = card.createEl("button", { text: "Preview revision" });
    preview.disabled = Boolean(this.active);
    preview.addEventListener("click", () => void this.previewRevision(snapshot, section, form));
    const cancel = card.createEl("button", { text: "Cancel revision" });
    cancel.addEventListener("click", () => { state.revisionForms.delete(section.envelope.id); void this.deps.rerender(); });
  }

  private renderRevisionPreview(card: HTMLElement, snapshot: ProjectSnapshot, document: ResearchDocumentRecord, section: ParsedDraftSection, preview: RevisionPreview): void {
    const state = this.stateFor();
    card.createEl("p", { cls: "cc-draft-provider", text: `${preview.request.intent}${preview.request.customInstruction ? ` · ${preview.request.customInstruction}` : ""} · ${preview.envelope.provider} · ${preview.envelope.model}` });
    card.createEl("pre", { cls: "cc-draft-preview", text: preview.response.markdown });
    this.renderDiff(card, section.markdown, preview.response.markdown, "Section revision before and after diff");
    if (!preview.response.canAccept) {
      card.createEl("p", { cls: "cc-research-error", attr: { role: "alert" }, text: "This revision cannot be accepted. Review the issues below, then discard it and try again." });
    }
    const report = card.createEl("details", { cls: "cc-revision-report" });
    if (!preview.response.canAccept) report.setAttribute("open", "");
    report.createEl("summary", { text: "Inspect preservation report" });
    report.createEl("p", { text: `${preview.response.claimPreservation.length} preserved claim · ${preview.response.support.length} supported passage${preview.response.support.length === 1 ? "" : "s"}` });
    for (const warning of preview.response.warnings) report.createEl("p", { cls: "cc-revision-warning", text: warning });
    for (const violation of preview.response.violations) report.createEl("p", { cls: "cc-research-error", text: violation });
    if (preview.response.canAccept) {
      const accept = card.createEl("button", { text: "Accept revision" });
      accept.addEventListener("click", () => void this.acceptRevision(snapshot.project.path, document.path, preview));
    }
    const discard = card.createEl("button", { text: "Discard revision" });
    discard.addEventListener("click", () => { state.revisionPreviews.delete(section.envelope.id); state.errors.delete(section.envelope.id); void this.deps.rerender(); });
  }

  private renderDiff(card: HTMLElement, before: string, after: string, label: string): void {
    if (before === after) {
      card.createEl("p", { cls: "cc-draft-unchanged", attr: { role: "status" }, text: "No text changes suggested." });
      return;
    }
    const diff = card.createDiv({ cls: "cc-draft-diff", attr: { "aria-label": label } });
    const hunk = planEdits(before, [{ old_str: before, new_str: after }]).hunks[0];
    if (hunk) {
      const lines = diff.createEl("pre", { cls: "cc-diff-lines" });
      for (const line of hunk.lines) lines.createDiv({ cls: `cc-diff-line is-${line.kind}`, text: `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}` });
    }
  }

  async preview(snapshot: ProjectSnapshot, section: ParsedDraftSection): Promise<void> {
    const state = this.stateFor();
    if (this.active || state.previews.has(section.envelope.id)) return;
    const controller = new AbortController();
    this.active = { controller, sectionId: section.envelope.id, kind: "draft" };
    state.errors.delete(section.envelope.id);
    try {
      await this.deps.rerender();
      if (controller.signal.aborted) return;
      const current = await this.deps.repository.loadProject(snapshot.project.path, { refreshBinaryFingerprints: true });
      if (controller.signal.aborted) return;
      const preview = await this.deps.coordinator.preview(current, section, controller.signal);
      if (!controller.signal.aborted) state.previews.set(section.envelope.id, preview);
    } catch (error) {
      if (!controller.signal.aborted) state.errors.set(section.envelope.id, safeDraftError(error));
    } finally {
      if (this.active?.controller === controller) {
        this.active = undefined;
        if (!controller.signal.aborted) await this.deps.rerender();
      }
    }
  }

  private async accept(projectPath: string, documentPath: string, preview: DraftPreview): Promise<void> {
    const state = this.stateFor(`${projectPath}\0${documentPath}`);
    state.errors.delete(preview.section.envelope.id);
    try {
      const current = await this.deps.repository.loadProject(projectPath, { refreshBinaryFingerprints: true });
      const packet = buildDraftGrounding(current, preview.packet.claim.path);
      await this.deps.repository.acceptDraftSection({ documentPath, preview: preview.section, envelope: preview.envelope, markdown: preview.response.markdown, currentEvidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), currentClaimFingerprint: groundingClaimFingerprint(packet) });
      state.previews.delete(preview.section.envelope.id);
    } catch (error) {
      state.errors.set(preview.section.envelope.id, safeDraftError(error));
    }
    await this.deps.rerender();
  }

  private async previewRevision(snapshot: ProjectSnapshot, section: ParsedDraftSection, form: { intent: RevisionIntent; customInstruction: string }): Promise<void> {
    const state = this.stateFor();
    if (!this.deps.revisionCoordinator || this.active || state.revisionPreviews.has(section.envelope.id)) return;
    const controller = new AbortController(); this.active = { controller, sectionId: section.envelope.id, kind: "revision" }; state.errors.delete(section.envelope.id);
    try {
      await this.deps.rerender();
      if (controller.signal.aborted) return;
      const request = { intent: form.intent, ...(form.customInstruction.trim() ? { customInstruction: form.customInstruction.trim() } : {}) };
      const current = await this.deps.repository.loadProject(snapshot.project.path, { refreshBinaryFingerprints: true });
      if (controller.signal.aborted) return;
      const preview = await this.deps.revisionCoordinator.preview(current, section, request, controller.signal);
      if (!controller.signal.aborted) state.revisionPreviews.set(section.envelope.id, preview);
    } catch (error) { if (!controller.signal.aborted) state.errors.set(section.envelope.id, safeDraftError(error)); }
    finally { if (this.active?.controller === controller) { this.active = undefined; if (!controller.signal.aborted) await this.deps.rerender(); } }
  }

  private async acceptRevision(projectPath: string, documentPath: string, preview: RevisionPreview): Promise<void> {
    const state = this.stateFor(`${projectPath}\0${documentPath}`);
    state.errors.delete(preview.section.envelope.id);
    try {
      const current = await this.deps.repository.loadProject(projectPath, { refreshBinaryFingerprints: true }); const packet = buildDraftGrounding(current, preview.packet.claim.path);
      await this.deps.repository.acceptRevisionSection({ documentPath, preview: preview.section, envelope: preview.envelope, markdown: preview.response.markdown, currentEvidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), currentClaimFingerprint: groundingClaimFingerprint(packet), packet, request: preview.request, response: preview.response });
      state.revisionPreviews.delete(preview.section.envelope.id); state.revisionForms.delete(preview.section.envelope.id);
    } catch (error) { state.errors.set(preview.section.envelope.id, safeDraftError(error)); }
    await this.deps.rerender();
  }
}
