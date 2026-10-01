import { Modal, type App } from "obsidian";
import type { EvidenceRecord, SourceLocatorKind } from "../../research/types";
import { sanitizeLoadError, type RewriteTextFn } from "./shared";

const INTERPRET_INSTRUCTION = "Write a one-to-three sentence interpretation of this evidence excerpt: what it shows and why it matters for the research project, stated cautiously without going beyond the excerpt.";
const LOCATOR_KINDS: SourceLocatorKind[] = ["page", "section", "paragraph", "timestamp", "quote"];

export interface EvidenceReviewResult {
  state: "reviewed" | "rejected";
  interpretation?: string;
  locator?: { kind: SourceLocatorKind; value: string };
}

export interface EvidenceReviewDeps {
  evidence: EvidenceRecord;
  stale: boolean;
  /** Text around the passage in the current source; null when it no longer appears; undefined when not shown. */
  context?: string | null;
  submit(result: EvidenceReviewResult): Promise<void>;
  openNote(): Promise<void>;
  rewriteText?: RewriteTextFn;
  label?: string;
}

export class EvidenceReviewModal extends Modal {
  constructor(app: App, private readonly deps: EvidenceReviewDeps) { super(app); }

  override onOpen(): void {
    const { evidence, stale, context, rewriteText } = this.deps;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `Check ${evidence.title}` });
    this.contentEl.createEl("p", { cls: "cc-research-modal-meta", text: evidence.source });
    if (stale) this.contentEl.createEl("p", { cls: "cc-research-stale-banner", attr: { role: "status" }, text: "The source changed since this was checked. Confirm the passage still says this." });
    this.contentEl.createEl("p", { cls: "cc-research-evidence-excerpt", text: evidence.excerpt });
    if (stale && context !== undefined) {
      this.contentEl.createEl("p", { cls: "cc-research-evidence-context", text: context === null ? "This passage no longer appears in the source." : context });
    }

    const locatorField = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    locatorField.createEl("label", { text: "Where to find it" });
    const locatorRow = locatorField.createDiv({ cls: "cc-research-locator-row" });
    const kind = locatorRow.createEl("select", { attr: { "aria-label": "Locator type" } });
    for (const value of LOCATOR_KINDS) kind.createEl("option", { text: value, value });
    kind.value = evidence.locatorKind ?? "page";
    const value = locatorRow.createEl("input", { attr: { "aria-label": "Locator value", placeholder: "e.g. 4 or Methods" } });
    value.value = evidence.locatorValue ?? "";

    const interpretationField = this.contentEl.createDiv({ cls: "cc-research-modal-field" });
    interpretationField.createEl("label", { text: "What this passage shows" });
    const interpretation = interpretationField.createEl("textarea", { attr: { "aria-label": "Evidence interpretation", rows: "3", placeholder: "What does this passage establish, and why does it matter?" } });
    interpretation.value = evidence.interpretation ?? "";
    const status = this.contentEl.createEl("p", { cls: "cc-research-modal-status", attr: { role: "status" } });
    const error = this.contentEl.createEl("p", { cls: "cc-research-error", attr: { role: "alert" } });
    const again = this.contentEl.createEl("button", { cls: "is-hidden", text: "Draft again" });

    let touched = false;
    interpretation.addEventListener("input", () => { touched = true; });
    const label = this.deps.label ? ` with ${this.deps.label}` : "";
    const draftInterpretation = (): void => {
      if (!rewriteText) return;
      const sourceInfo = `Source: ${evidence.title} (${evidence.source}${evidence.locatorValue ? `, ${evidence.locatorKind ?? "locator"} ${evidence.locatorValue}` : ""})\nExcerpt:\n${evidence.excerpt}`;
      status.setText(`Drafting${label}…`);
      error.setText("");
      again.addClass("is-hidden");
      void rewriteText({ text: "Draft the interpretation for this evidence.", instruction: INTERPRET_INSTRUCTION, context: sourceInfo })
        .then((result) => { if (!touched && !interpretation.value.trim()) interpretation.value = result; status.setText(""); })
        .catch((cause) => { status.setText(""); error.setText(`Couldn't draft this. ${sanitizeLoadError(cause)}`); again.removeClass("is-hidden"); });
    };
    again.addEventListener("click", draftInterpretation);
    if (rewriteText && !interpretation.value.trim()) draftInterpretation();

    const actions = this.contentEl.createDiv({ cls: "cc-research-modal-actions" });
    const complete = (state: "reviewed" | "rejected"): void => {
      const text = interpretation.value.trim();
      const locator = value.value.trim();
      const changed = locator && (locator !== (evidence.locatorValue ?? "") || kind.value !== evidence.locatorKind);
      void this.deps.submit({
        state,
        ...(text && text !== (evidence.interpretation ?? "") ? { interpretation: text } : {}),
        ...(changed ? { locator: { kind: kind.value as SourceLocatorKind, value: locator } } : {}),
      }).then(() => this.close()).catch((cause) => error.setText(sanitizeLoadError(cause)));
    };
    actions.createEl("button", { cls: "mod-cta", text: "Keep" }).addEventListener("click", () => complete("reviewed"));
    actions.createEl("button", { text: "Reject" }).addEventListener("click", () => complete("rejected"));
    actions.createEl("button", { text: "Open note" }).addEventListener("click", () => void this.deps.openNote().catch((cause) => error.setText(sanitizeLoadError(cause))));
  }
}
