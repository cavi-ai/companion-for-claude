import { App, Modal } from "obsidian";

export interface ChoiceButton<T extends string> {
  label: string;
  value: T;
  cta?: boolean;
}

/**
 * Generic one-question confirm dialog (first-run consent / onboarding prompts).
 * Closing without choosing resolves to `fallback` — callers pick a fail-safe.
 */
export class ChoiceModal<T extends string> extends Modal {
  private choice: T;

  constructor(
    app: App,
    private opts: {
      title: string;
      message: string;
      buttons: Array<ChoiceButton<T>>;
      fallback: T;
      onChoice: (choice: T) => void;
    },
  ) {
    super(app);
    this.choice = opts.fallback;
  }

  override onOpen(): void {
    this.titleEl.setText(this.opts.title);
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.opts.message });
    const buttons = contentEl.createDiv({ cls: "cc-write-buttons" });
    for (const b of this.opts.buttons) {
      const el = buttons.createEl("button", { text: b.label });
      if (b.cta) el.addClass("mod-cta");
      el.addEventListener("click", () => {
        this.choice = b.value;
        this.close();
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    this.opts.onChoice(this.choice);
  }
}
