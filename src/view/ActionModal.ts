import { App, Modal, setIcon } from "obsidian";

export interface ActionModalItem {
  title: string;
  icon?: string;
  checked?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

/** Touch-safe action sheet used where a mouse-positioned menu is unreliable. */
export class ActionModal extends Modal {
  constructor(app: App, private heading: string, private items: ActionModalItem[]) { super(app); }

  override onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.addClass("cc-action-sheet");
    for (const item of this.items) {
      if (item.separatorBefore) this.contentEl.createDiv({ cls: "cc-action-sheet-separator" });
      const button = this.contentEl.createEl("button", {
        cls: "cc-action-sheet-item",
        attr: { type: "button", "aria-label": item.title, ...(item.checked !== undefined ? { "aria-pressed": String(item.checked) } : {}) },
      });
      const icon = button.createSpan({ cls: "cc-action-sheet-icon" });
      if (item.icon) setIcon(icon, item.icon);
      button.createSpan({ text: item.title });
      if (item.checked) setIcon(button.createSpan({ cls: "cc-action-sheet-check" }), "check");
      button.addEventListener("click", () => { this.close(); item.run(); });
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}
