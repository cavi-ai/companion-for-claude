import { App, Modal } from "obsidian";
import { REWRITE_PRESETS } from "../edit/rewrite";

/**
 * Instruction picker for inline rewrite: preset buttons fill the textarea,
 * a custom instruction can be typed or edited, Cmd/Ctrl+Enter submits.
 * Closing without submitting resolves null — nothing runs without an explicit
 * instruction.
 */
export class RewriteModal extends Modal {
  private submitted: string | null = null;

  constructor(
    app: App,
    private selectionChars: number,
    private onDone: (instruction: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Rewrite selection with Claude");
    const { contentEl } = this;
    contentEl.addClass("cc-rewrite-modal");
    contentEl.createDiv({ cls: "cc-diff-description", text: `${this.selectionChars} characters selected` });

    const area = contentEl.createEl("textarea", {
      cls: "cc-rewrite-input",
      attr: { rows: "3", placeholder: "How should Claude rewrite it? (pick a preset or type your own)" },
    });

    const presets = contentEl.createDiv({ cls: "cc-rewrite-presets" });
    for (const preset of REWRITE_PRESETS) {
      const btn = presets.createEl("button", { text: preset.label, cls: "cc-rewrite-preset" });
      btn.addEventListener("click", () => {
        area.value = preset.instruction;
        area.focus();
      });
    }

    const submit = () => {
      const value = area.value.trim();
      if (value.length === 0) return;
      this.submitted = value;
      this.close();
    };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });

    const buttons = contentEl.createDiv({ cls: "cc-diff-buttons" });
    buttons.createSpan({ cls: "cc-rewrite-hint", text: "⌘/Ctrl+Enter" });
    const go = buttons.createEl("button", { text: "Rewrite", cls: "mod-cta" });
    go.addEventListener("click", submit);
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    window.setTimeout(() => area.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onDone(this.submitted);
  }
}
