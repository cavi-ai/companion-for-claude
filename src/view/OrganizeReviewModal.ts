import { App, Modal, Setting } from "obsidian";
import type { OrganizeMove } from "../sources/organize";

/**
 * Review gate for the clipping organizer: every proposed rename+move, grouped
 * by destination folder and checked by default (misc rows start unchecked).
 * Apply moves only the selected subset. Nothing touches the vault before this
 * resolves.
 */
export class OrganizeReviewModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private moves: OrganizeMove[],
    private unresolvedCount: number,
    private onDone: (accepted: OrganizeMove[] | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Organize ${this.moves.length} clipping${this.moves.length === 1 ? "" : "s"}`);
    const { contentEl } = this;
    contentEl.addClass("cc-organize-review");

    if (this.unresolvedCount > 0) {
      contentEl.createDiv({
        cls: "cc-organize-unresolved",
        text: `${this.unresolvedCount} clip${this.unresolvedCount === 1 ? "" : "s"} could not be classified and are not in this plan.`,
      });
    }

    const groups = new Map<string, OrganizeMove[]>();
    for (const move of this.moves) {
      const group = groups.get(move.domain);
      if (group) group.push(move);
      else groups.set(move.domain, [move]);
    }

    const checks: Array<{ move: OrganizeMove; el: HTMLInputElement }> = [];
    for (const [domain, moves] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      contentEl.createDiv({ cls: "cc-organize-group-heading", text: `${domain} (${moves.length})` });
      for (const move of moves) {
        const row = contentEl.createDiv({ cls: "cc-organize-row" });
        const check = row.createEl("input", { attr: { type: "checkbox" } });
        check.checked = domain !== "misc";
        checks.push({ move, el: check });
        const text = row.createDiv({ cls: "cc-organize-text" });
        text.createDiv({ cls: "cc-organize-from", text: move.from });
        text.createDiv({ cls: "cc-organize-to", text: `→ ${move.to}` });
      }
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
