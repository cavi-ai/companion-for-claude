import { Modal, type App } from "obsidian";
import type { ClaimSuggestion } from "../../research/claimSuggestion";
import type { ProjectClaim } from "../../research/graph";
import type { EvidenceRecord, EvidenceRelation } from "../../research/types";
import { sanitizeLoadError, type RewriteTextFn } from "./shared";

export interface ClaimModalInput {
  title: string;
  proposition: string;
  confidence: "low" | "moderate" | "high";
  supports: string[];
  challenges: string[];
  contextualizes: string[];
}

const SHARPEN_INSTRUCTION = "Rewrite as one precise, defensible claim proposition: a single sentence, hedged to what the grounding evidence supports, no rhetorical framing.";
const LIMITATION_INSTRUCTION = "Write one sentence naming the scope this claim does not cover, based on what the challenging passages show. Use only what the passages say.";
const RELATIONS: EvidenceRelation[] = ["supports", "challenges", "contextualizes"];

export interface ClaimCreateDeps {
  evidence: EvidenceRecord[];
  submit(input: ClaimModalInput): Promise<void>;
  rewriteText?: RewriteTextFn;
  /** Drafts the whole claim; absent when research AI is unavailable. */
  suggest?: () => Promise<ClaimSuggestion | null>;
  label?: string;
}

export class ClaimCreateModal extends Modal {
  constructor(app: App, private readonly deps: ClaimCreateDeps) { super(app); }
  override onOpen(): void {
    const { evidence, rewriteText, suggest } = this.deps;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "New claim" });
    const status = this.contentEl.createEl("p", { cls: "cc-research-modal-status", attr: { role: "status" } });
    const title = this.field("Short title", "input") as HTMLInputElement;
    const proposition = this.field("Claim", "textarea") as HTMLTextAreaElement;
    const confidenceWrap = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    confidenceWrap.createEl("label", { text: "Confidence" });
    const confidence = confidenceWrap.createEl("select", { attr: { "aria-label": "Claim confidence" } });
    for (const value of ["low", "moderate", "high"]) confidence.createEl("option", { text: value, value });
    confidence.value = "moderate";
    const touched = { title: false, proposition: false, confidence: false, relations: false };
    title.addEventListener("input", () => { touched.title = true; });
    proposition.addEventListener("input", () => { touched.proposition = true; });
    confidence.addEventListener("change", () => { touched.confidence = true; });
    const relations = new Map<string, Record<EvidenceRelation, HTMLInputElement>>();
    for (const item of evidence) {
      const row = this.contentEl.createDiv({ cls: "cc-research-claim-evidence" });
      row.createEl("strong", { text: item.title });
      row.createEl("p", { text: item.excerpt });
      const inputs = {} as Record<EvidenceRelation, HTMLInputElement>;
      for (const relation of RELATIONS) {
        const label = row.createEl("label", { text: relation });
        const input = label.createEl("input", { attr: { type: "checkbox", "aria-label": `${item.title} ${relation}` } });
        input.addEventListener("change", () => {
          touched.relations = true;
          if (input.checked) for (const other of Object.values(inputs)) if (other !== input) other.checked = false;
        });
        inputs[relation] = input;
      }
      relations.set(item.path, inputs);
    }
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });

    const label = this.deps.label ? ` with ${this.deps.label}` : "";
    let run = 0;
    const draftClaim = (): void => {
      if (!suggest) return;
      const mine = ++run;
      status.setText(`Drafting a claim${label}…`);
      error.setText("");
      void suggest()
        .then((result) => {
          if (mine !== run) return;
          if (!result) { status.setText("Couldn't draft a claim. Fill it in below."); error.setText("The reply wasn't usable."); return; }
          if (!touched.title) title.value = result.title;
          if (!touched.proposition) proposition.value = result.proposition;
          if (!touched.confidence) confidence.value = result.confidence;
          if (!touched.relations) for (const [path, inputs] of relations) for (const relation of RELATIONS) inputs[relation].checked = result.relations[path] === relation;
          status.setText("");
        })
        .catch((cause) => { if (mine !== run) return; status.setText("Couldn't draft a claim. Fill it in below."); error.setText(sanitizeLoadError(cause)); });
    };
    if (suggest) {
      const again = this.contentEl.createDiv({ cls: "cc-research-modal-actions" }).createEl("button", { text: "Suggest again" });
      again.addEventListener("click", draftClaim);
      draftClaim();
    }

    if (rewriteText) {
      let sharpened: string | null = null;
      const preview = this.contentEl.createDiv({ cls: "cc-research-sharpen-preview is-hidden" });
      preview.createEl("strong", { text: "Sharper wording" });
      const previewText = preview.createEl("p", { cls: "cc-research-sharpen-text" });
      const previewActions = preview.createDiv({ cls: "cc-research-modal-actions" });
      const use = previewActions.createEl("button", { cls: "mod-cta", text: "Use this" });
      use.addEventListener("click", () => { if (sharpened !== null) { proposition.value = sharpened; touched.proposition = true; } sharpened = null; preview.addClass("is-hidden"); });
      const dismiss = previewActions.createEl("button", { text: "Dismiss" });
      dismiss.addEventListener("click", () => { sharpened = null; preview.addClass("is-hidden"); });

      const sharpenWrap = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
      const sharpen = sharpenWrap.createEl("button", { text: "Sharpen with Claude", attr: { "aria-label": "Sharpen the claim with Claude, using the linked passages" } });
      sharpen.addEventListener("click", () => {
        const draft = proposition.value.trim();
        if (!draft) { error.setText("Write the claim first, then sharpen it."); return; }
        const context = evidence
          .flatMap((item) => {
            const choices = relations.get(item.path);
            const relation = choices ? RELATIONS.find((name) => choices[name].checked) : undefined;
            return relation ? [`Evidence (${relation}) — ${item.title}: ${item.excerpt}`] : [];
          })
          .join("\n");
        sharpen.disabled = true;
        sharpen.setText("Sharpening…");
        error.setText("");
        void rewriteText({ text: draft, instruction: SHARPEN_INSTRUCTION, ...(context ? { context } : {}) })
          .then((result) => { sharpened = result; previewText.setText(result); preview.removeClass("is-hidden"); })
          .catch((cause) => error.setText(sanitizeLoadError(cause)))
          .finally(() => { sharpen.disabled = false; sharpen.setText("Sharpen with Claude"); });
      });
    }

    const submitBar = this.contentEl.createDiv({ cls: "cc-research-modal-submit-bar" });
    const button = submitBar.createEl("button", { cls: "mod-cta", text: "Create claim" });
    button.addEventListener("click", () => {
      const input: ClaimModalInput = { title: title.value, proposition: proposition.value, confidence: confidence.value as ClaimModalInput["confidence"], supports: [], challenges: [], contextualizes: [] };
      for (const [path, choices] of relations) for (const relation of RELATIONS) if (choices[relation].checked) input[relation].push(path);
      if (!input.title.trim() || !input.proposition.trim()) { error.setText("Add a short title and the claim."); return; }
      if (![...input.supports, ...input.challenges, ...input.contextualizes].length) { error.setText("Link at least one passage."); return; }
      void this.deps.submit(input).then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    });
  }
  private field(labelText: string, kind: "input" | "textarea"): HTMLInputElement | HTMLTextAreaElement {
    const wrapper = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    wrapper.createEl("label", { text: labelText });
    return wrapper.createEl(kind, { attr: { "aria-label": labelText } });
  }
}

export interface ClaimReviewResult {
  state: "reviewed" | "rejected";
  limitation?: string;
  link: string[];
}

export interface ClaimReviewDeps {
  claim: ProjectClaim;
  evidence: EvidenceRecord[];
  /** Reviewed passages not yet linked to this claim. */
  linkable: EvidenceRecord[];
  submit(result: ClaimReviewResult): Promise<void>;
  openNote(): Promise<void>;
  rewriteText?: RewriteTextFn;
  label?: string;
}

export class ClaimReviewModal extends Modal {
  constructor(app: App, private readonly deps: ClaimReviewDeps) { super(app); }
  override onOpen(): void {
    const { claim, evidence, linkable, rewriteText } = this.deps;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `Check claim ${claim.title}` });
    this.contentEl.createEl("p", { cls: "cc-research-claim-proposition", text: claim.proposition });
    this.contentEl.createEl("p", { cls: "cc-research-modal-meta", text: `Confidence: ${claim.confidence}` });
    const byPath = new Map(evidence.map((item) => [item.path, item]));
    const groups: Array<[string, string[]]> = [["Supports", claim.supporting], ["Challenges", claim.challenging], ["Context", claim.contextual]];
    for (const [heading, paths] of groups) {
      if (!paths.length) continue;
      const group = this.contentEl.createDiv({ cls: "cc-research-claim-group" });
      group.createEl("h4", { text: heading });
      for (const path of paths) {
        const item = byPath.get(path);
        const row = group.createDiv({ cls: "cc-research-claim-evidence" });
        row.createEl("strong", { text: item?.title ?? path });
        if (item) row.createEl("p", { text: item.excerpt });
      }
    }

    const status = this.contentEl.createEl("p", { cls: "cc-research-modal-status", attr: { role: "status" } });
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });

    let limitation: HTMLTextAreaElement | undefined;
    if (claim.challenging.length) {
      const field = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
      field.createEl("label", { text: "What this claim doesn't cover" });
      limitation = field.createEl("textarea", { attr: { "aria-label": "What this claim doesn't cover", rows: "2" } });
      const box = limitation;
      let touched = false;
      box.addEventListener("input", () => { touched = true; });
      if (rewriteText && !claim.limitations.length) {
        const context = claim.challenging.flatMap((path) => { const item = byPath.get(path); return item ? [`Challenging passage — ${item.title}: ${item.excerpt}`] : []; }).join("\n");
        status.setText(`Drafting${this.deps.label ? ` with ${this.deps.label}` : ""}…`);
        void rewriteText({ text: claim.proposition, instruction: LIMITATION_INSTRUCTION, context })
          .then((result) => { if (!touched && !box.value.trim()) box.value = result; status.setText(""); })
          .catch((cause) => { status.setText(""); error.setText(`Couldn't draft this. ${sanitizeLoadError(cause)}`); });
      }
    }

    const picks = new Map<string, HTMLInputElement>();
    if (claim.trustedSupportCount === 0 && linkable.length) {
      const group = this.contentEl.createDiv({ cls: "cc-research-claim-group" });
      group.createEl("h4", { text: "Link a passage that supports it" });
      for (const item of linkable) {
        const row = group.createEl("label", { cls: "cc-research-claim-evidence" });
        picks.set(item.path, row.createEl("input", { attr: { type: "checkbox", "aria-label": `Link ${item.title}` } }));
        row.createEl("strong", { text: item.title });
        row.createEl("p", { text: item.excerpt });
      }
    }

    const actions = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
    const complete = (state: "reviewed" | "rejected"): void => {
      const note = limitation?.value.trim();
      void this.deps.submit({ state, ...(note ? { limitation: note } : {}), link: [...picks].filter(([, input]) => input.checked).map(([path]) => path) })
        .then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    };
    actions.createEl("button", { cls: "mod-cta", text: "Mark reviewed" }).addEventListener("click", () => complete("reviewed"));
    actions.createEl("button", { text: "Reject" }).addEventListener("click", () => complete("rejected"));
    actions.createEl("button", { text: "Open note" }).addEventListener("click", () => void this.deps.openNote().catch((cause) => error.setText(sanitizeLoadError(cause))));
  }
}
