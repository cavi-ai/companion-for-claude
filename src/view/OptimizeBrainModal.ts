import { App, Modal, Notice, Setting } from "obsidian";
import { formatClassifyNotice, type ApplyResult, type ClassifyResult } from "../optimize/controller";
import type { MergeCandidate } from "../optimize/tagScan";
import { createOptimizeState, removeRow, selectedMerges, swapRow, toggleRow, type OptimizeViewState } from "./optimizeState";

export interface OptimizeBrainActions {
  apply(merges: Array<{ from: string; to: string }>): Promise<ApplyResult>;
  dismiss(id: string): Promise<void>;
  classify(signal: AbortSignal): Promise<ClassifyResult>;
  rescan(): Promise<MergeCandidate[]>;
  classifierInfo(): Promise<{ label: string; model: string } | { needsConfirmation: true }>;
}

type ClassifierLine = { text: string; ready: boolean };

/** Review gate for tag merges: nothing is written until Apply. */
export class OptimizeBrainModal extends Modal {
  private state: OptimizeViewState;
  private settled = false;
  private applying = false;
  private checking = false;
  private checkAbort: AbortController | null = null;
  private classifierLine: ClassifierLine | null = null;

  constructor(
    app: App,
    candidates: MergeCandidate[],
    private actions: OptimizeBrainActions,
    private onDone: (result: ApplyResult | null) => void,
  ) {
    super(app);
    this.state = createOptimizeState(candidates);
  }

  override onOpen(): void {
    this.contentEl.addClass("cc-optimize-review");
    this.render();
    void this.actions.classifierInfo().then(
      (info) =>
        this.setClassifierLine(
          "needsConfirmation" in info
            ? { text: "Sends tag names and up to 3 note titles per tag to your utility model. You will be asked before Claude is used instead.", ready: true }
            : { text: `Sends tag names and up to 3 note titles per tag to ${info.label} (${info.model}).`, ready: true },
        ),
      (error: unknown) => this.setClassifierLine({ text: errorMessage(error), ready: false }),
    );
  }

  private setClassifierLine(line: ClassifierLine): void {
    this.classifierLine = line;
    if (!this.settled) this.render();
  }

  private runClassify(): void {
    if (this.checking || this.applying || this.settled) return;
    const control = new AbortController();
    this.checkAbort = control;
    this.checking = true;
    this.render();
    void (async () => {
      try {
        const result = await this.actions.classify(control.signal);
        if (control.signal.aborted) return;
        this.state = createOptimizeState(await this.actions.rescan(), this.state);
        if (!control.signal.aborted) new Notice(formatClassifyNotice(result));
      } catch (error) {
        if (control.signal.aborted) return;
        new Notice(`Tag check failed: ${errorMessage(error)}`);
        try {
          this.state = createOptimizeState(await this.actions.rescan(), this.state);
        } catch {
          // keep the rows already on screen
        }
      } finally {
        this.checking = false;
        if (this.checkAbort === control) this.checkAbort = null;
        if (!this.settled && !control.signal.aborted) this.render();
      }
    })();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`Review ${this.state.rows.length} tag ${this.state.rows.length === 1 ? "merge" : "merges"}`);
    contentEl.createDiv({
      text: "Merges rewrite tags in notes. Saved searches, Bases, and queries that name a merged tag are not changed.",
    });
    if (this.state.rows.length === 0) contentEl.createDiv({ text: "No tag merges to review." });
    for (const row of this.state.rows) {
      const setting = new Setting(contentEl)
        .setName(`${row.from} (${row.fromCount}) → ${row.to} (${row.toCount})`)
        .setDesc(`${row.evidence.join(", ")}${row.verdict ? ` · model: ${row.verdict.verdict}` : ""}`);
      const check = setting.controlEl.createEl("input", { attr: { type: "checkbox" } });
      check.checked = row.checked;
      check.addEventListener("change", () => {
        this.state = toggleRow(this.state, row.id, check.checked);
      });
      setting
        .addButton((b) => b.setButtonText("Swap").onClick(() => {
          this.state = swapRow(this.state, row.id);
          this.render();
        }))
        .addButton((b) => b.setButtonText("Dismiss").onClick(() => {
          void this.actions.dismiss(row.id).then(
            () => {
              this.state = removeRow(this.state, row.id);
              this.render();
            },
            (error: unknown) => new Notice(`Tag dismiss failed: ${errorMessage(error)}`),
          );
        }));
    }
    if (this.classifierLine) contentEl.createDiv({ text: this.classifierLine.text });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Check with model").setDisabled(this.checking || this.applying || !this.classifierLine?.ready).onClick(() => this.runClassify()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => (this.applying ? this.close() : this.finish(null))))
      .addButton((b) => b.setButtonText("Apply selected").setCta().setDisabled(this.checking || this.applying).onClick(() => {
        if (this.applying || this.checking || this.settled) return;
        this.applying = true;
        this.render();
        void this.actions.apply(selectedMerges(this.state)).then(
          (result) => this.finish(result),
          (error: unknown) => {
            new Notice(`Tag merge failed: ${errorMessage(error)}`);
            this.finish(null);
          },
        );
      }));
  }

  private finish(result: ApplyResult | null): void {
    this.applying = false;
    if (!this.settled) {
      this.settled = true;
      this.onDone(result);
    }
    this.close();
  }

  override onClose(): void {
    this.checkAbort?.abort();
    if (!this.settled && !this.applying) {
      this.settled = true;
      this.onDone(null);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
