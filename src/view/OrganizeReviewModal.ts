import { App, Modal, Setting } from "obsidian";
import type { OrganizeMove } from "../sources/organize";

/**
 * Review gate for the clipping organizer: every proposed rename+move, checked
 * by default; Apply moves only the selected subset. Nothing touches the vault
 * before this resolves.
 */
export class OrganizeReviewModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private moves: OrganizeMove[],
    private onDone: (accepted: OrganizeMove[] | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Organize ${this.moves.length} clipping${this.moves.length === 1 ? "" : "s"}`);
    const { contentEl } = this;
    contentEl.addClass("cc-organize-review");

    const checks: Array<{ move: OrganizeMove; el: HTMLInputElement }> = [];
    for (const move of this.moves) {
      const row = contentEl.createDiv({ cls: "cc-organize-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      checks.push({ move, el: check });
      const text = row.createDiv({ cls: "cc-organize-text" });
      text.createDiv({ cls: "cc-organize-from", text: move.from });
      text.createDiv({ cls: "cc-organize-to", text: `→ ${move.to}` });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.decided = true;
          this.onDone(null);
          this.close();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Move selected")
          .setCta()
          .onClick(() => {
            this.decided = true;
            this.onDone(checks.filter(({ el }) => el.checked).map(({ move }) => move));
            this.close();
          }),
      );
  }

  override onClose(): void {
    if (!this.decided) this.onDone(null);
  }
}
