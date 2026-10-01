import { App, Modal, Setting } from "obsidian";
import type { SafeFix } from "../health/controller";

/** Review gate for ontology auto-fixes: only checked notes, only changed keys. */
export class SafeFixModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private fixes: SafeFix[],
    private write: (path: string, patch: Record<string, unknown>) => Promise<void>,
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
      const row = contentEl.createDiv({ cls: "cc-safe-fix-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      checks.push({ fix, el: check });
      const text = row.createDiv({ cls: "cc-safe-fix-text" });
      text.createDiv({ cls: "cc-safe-fix-path", text: fix.path });
      for (const c of fix.changes) text.createDiv({ cls: "cc-safe-fix-change", text: `${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}` });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => { this.decided = true; this.onDone(0); this.close(); }))
      .addButton((b) => b.setButtonText("Apply selected").setCta().onClick(() => {
        this.decided = true;
        void (async () => {
          const chosen = checks.filter(({ el }) => el.checked).map(({ fix }) => fix);
          for (const fix of chosen) await this.write(fix.path, Object.fromEntries(fix.changes.map((c) => [c.key, c.to])));
          this.onDone(chosen.length);
        })();
        this.close();
      }));
  }

  override onClose(): void {
    if (!this.decided) this.onDone(0);
  }
}
