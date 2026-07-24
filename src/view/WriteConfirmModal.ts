import { App, Modal } from "obsidian";
import type { ToolUseBlock } from "../providers/types";

export type WriteChoice = "allow" | "always" | "deny";

/**
 * Confirmation dialog shown before any agent write tool touches the vault
 * (spec 2026-07-05 §7). Closing the dialog without choosing counts as deny —
 * writes fail closed.
 */
export class WriteConfirmModal extends Modal {
  private choice: WriteChoice = "deny";

  constructor(
    app: App,
    private block: ToolUseBlock,
    private onChoice: (choice: WriteChoice) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Claude wants to modify your vault");
    const { contentEl } = this;
    contentEl.addClass("cc-write-confirm");

    const target = this.targetLabel();
    contentEl.createDiv({ cls: "cc-write-tool", text: `${this.block.name}${target ? ` — ${target}` : ""}` });

    const preview = this.contentPreview();
    if (preview) contentEl.createEl("pre", { cls: "cc-write-preview", text: preview });

    const buttons = contentEl.createDiv({ cls: "cc-write-buttons" });
    const mk = (text: string, choice: WriteChoice, cta = false) => {
      const b = buttons.createEl("button", { text });
      if (cta) b.addClass("mod-cta");
      b.addEventListener("click", () => {
        this.choice = choice;
        this.close();
      });
    };
    mk("Allow", "allow", true);
    mk("Allow for this session", "always");
    mk("Deny", "deny");
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onChoice(this.choice);
  }

  /** The note path/title the write targets, when the args carry one. */
  private targetLabel(): string {
    const input = this.block.input;
    const v = input.path ?? input.title ?? input.to;
    return typeof v === "string" ? v : "";
  }

  private contentPreview(): string {
    const c = this.block.input.content;
    if (typeof c !== "string" || c.length === 0) return "";
    return c.length > 600 ? `${c.slice(0, 600)}…` : c;
  }
}
