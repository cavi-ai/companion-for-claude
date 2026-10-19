import { App, Modal, Notice, Setting } from "obsidian";
import type { SafeFix } from "../health/controller";

/** Review gate for ontology auto-fixes: only checked notes, only changed keys. */
export class SafeFixModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private fixes: SafeFix[],
    private write: (fix: SafeFix) => Promise<void>,
    private onDone: (applied: number) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Review ${this.fixes.length} safe fix${this.fixes.length === 1 ? "" : "es"}`);
    const { contentEl } = this;
    contentEl.addClass("cc-safe-fix-review");
    const checks: Array<{ fix: SafeFix; el: HTMLInputElement }> = [];
    for (const fix of this.fixes) {
      const row = contentEl.createEl("label", { cls: "cc-safe-fix-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      checks.push({ fix, el: check });
      const text = row.createSpan({ cls: "cc-safe-fix-text" });
      text.createSpan({ cls: "cc-safe-fix-path", text: fix.path });
      for (const c of fix.changes) text.createSpan({ cls: "cc-safe-fix-change", text: `${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}` });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => { this.decided = true; this.onDone(0); this.close(); }))
      .addButton((b) => b.setButtonText("Apply selected").setCta().onClick(() => {
        if (this.decided) return;
        this.decided = true;
        void (async () => {
          const chosen = checks.filter(({ el }) => el.checked).map(({ fix }) => fix);
          const failed: string[] = [];
          let applied = 0;
          for (const fix of chosen) {
            try {
              await this.write(fix);
              applied++;
            } catch (error) {
              failed.push(`${fix.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          new Notice(`Applied ${applied} of ${chosen.length} selected fixes.${failed.length > 0 ? `\n${failed.join("\n")}` : ""}`, failed.length > 0 ? 12000 : 6000);
          this.onDone(applied);
        })();
        this.close();
      }));
  }

  override onClose(): void {
    if (!this.decided) this.onDone(0);
  }
}
