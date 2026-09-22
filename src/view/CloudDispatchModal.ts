import { App, Modal, Notice } from "obsidian";

/** Minimal prompt for what a dispatched cloud session should do. */
export class CloudDispatchModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private context: string | undefined,
    private onSubmit: (instruction: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Send to cloud Claude session" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Fires your Claude Code routine in the cloud against your vault's repo. What should it do?",
    });
    if (this.context) {
      contentEl.createEl("p", { cls: "setting-item-description", text: `Attaching — ${this.context.split("\n")[0]}` });
    }

    const ta = contentEl.createEl("textarea");
    ta.rows = 5;
    ta.setCssStyles({ width: "100%" });
    ta.placeholder = "e.g. Summarize this week's meeting notes into a decisions log and open a PR.";
    ta.addEventListener("input", () => (this.value = ta.value));
    window.setTimeout(() => ta.focus(), 0);

    const controls = contentEl.createDiv({ cls: "modal-button-container" });
    const send = controls.createEl("button", { text: "Dispatch", cls: "mod-cta" });
    send.addEventListener("click", () => {
      const v = this.value.trim();
      if (!v) {
        new Notice("Type what the cloud session should do.");
        return;
      }
      this.close();
      this.onSubmit(v);
    });
    controls.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
