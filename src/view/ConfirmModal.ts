import { App, Modal } from "obsidian";

/** A simple confirm/cancel dialog that resolves a boolean. */
export class ConfirmModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private opts: { title: string; body: string; cta: string; onResolve: (ok: boolean) => void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.opts.title);
    const p = this.contentEl.createEl("p", { cls: "setting-item-description" });
    p.setCssStyles({ whiteSpace: "pre-wrap" });
    p.setText(this.opts.body);
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const ok = row.createEl("button", { cls: "mod-cta", text: this.opts.cta });
    ok.addEventListener("click", () => {
      this.decided = true;
      this.opts.onResolve(true);
      this.close();
    });
  }

  override onClose(): void {
    if (!this.decided) this.opts.onResolve(false);
  }
}
