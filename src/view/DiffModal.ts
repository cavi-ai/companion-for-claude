import { App, Modal } from "obsidian";
import type { EditPlan } from "../edit/diff";

export interface DiffModalInput {
  /** Vault path of the note being edited. */
  path: string;
  /** Claude's one-line rationale for the edit (optional). */
  description?: string;
  plan: EditPlan;
}

/**
 * Per-hunk review of a proposed note edit (spec 2026-07-05 apply-to-note).
 * Each hunk has an accept checkbox (default checked); "Apply selected" resolves
 * with the accepted flags, "Reject all" or closing the dialog resolves null —
 * edits fail closed, nothing touches the vault without an explicit apply.
 */
export class DiffModal extends Modal {
  private accepted: boolean[];
  private applied = false;

  constructor(
    app: App,
    private input: DiffModalInput,
    private onDone: (accepted: boolean[] | null) => void,
  ) {
    super(app);
    this.accepted = input.plan.hunks.map(() => true);
  }

  override onOpen(): void {
    this.titleEl.setText(`Proposed edit — ${this.input.path}`);
    const { contentEl } = this;
    contentEl.addClass("cc-diff-modal");

    if (this.input.description) contentEl.createDiv({ cls: "cc-diff-description", text: this.input.description });

    for (const [i, hunk] of this.input.plan.hunks.entries()) {
      const box = contentEl.createDiv({ cls: "cc-diff-hunk" });
      const header = box.createEl("label", { cls: "cc-diff-hunk-header" });
      const check = header.createEl("input", { type: "checkbox" });
      check.checked = true;
      check.addEventListener("change", () => {
        this.accepted[i] = check.checked;
        box.toggleClass("is-rejected", !check.checked);
      });
      header.createSpan({ cls: "cc-diff-hunk-title", text: `Change ${i + 1} — line ${hunk.lineno}` });

      const body = box.createEl("pre", { cls: "cc-diff-lines" });
      for (const line of hunk.lines) {
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        body.createDiv({ cls: `cc-diff-line is-${line.kind}`, text: `${marker} ${line.text}` });
      }
    }

    const buttons = contentEl.createDiv({ cls: "cc-diff-buttons" });
    const apply = buttons.createEl("button", { text: "Apply selected", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      this.applied = true;
      this.close();
    });
    const reject = buttons.createEl("button", { text: "Reject all" });
    reject.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onDone(this.applied && this.accepted.some(Boolean) ? this.accepted : null);
  }
}
