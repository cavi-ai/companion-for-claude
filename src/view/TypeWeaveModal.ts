import { App, Modal, Notice, Setting } from "obsidian";
import { formatTypeClassifyNotice, type TypeApplyResult, type TypeClassifyResult } from "../optimize/typeController";
import type { TypeScanReport } from "../optimize/typeScan";
import { createTypeWeaveState, removeRow, rowDescription, selectedTypes, setRowType, toggleRow, type TypeWeaveViewState } from "./typeWeaveState";

export interface TypeWeaveActions {
  apply(rows: Array<{ path: string; type: string }>): Promise<TypeApplyResult>;
  dismiss(path: string): Promise<void>;
  classify(signal: AbortSignal): Promise<TypeClassifyResult>;
  rescan(): Promise<TypeScanReport>;
  classifierInfo(): Promise<{ label: string; model: string } | { needsConfirmation: true }>;
}

type ClassifierLine = { text: string; ready: boolean };

const SENT = "Sends each note's title, folder, tags, up to 5 headings, and its first 200 characters to";

/** Review gate for note types: nothing is written until Apply, and only `type` is written. */
export class TypeWeaveModal extends Modal {
  private state: TypeWeaveViewState;
  private settled = false;
  private applying = false;
  private checking = false;
  private checkAbort: AbortController | null = null;
  private classifierLine: ClassifierLine | null = null;

  constructor(
    app: App,
    report: Pick<TypeScanReport, "proposals" | "proposable" | "noProposal" | "notShown">,
    private actions: TypeWeaveActions,
    private onDone: (result: TypeApplyResult | null) => void,
  ) {
    super(app);
    this.state = createTypeWeaveState(report);
  }

  override onOpen(): void {
    this.contentEl.addClass("cc-type-weave-review");
    this.render();
    void this.actions.classifierInfo().then(
      (info) =>
        this.setClassifierLine(
          "needsConfirmation" in info
            ? { text: `${SENT} your utility model. You will be asked before Claude is used instead.`, ready: true }
            : { text: `${SENT} ${info.label} (${info.model}).`, ready: true },
        ),
      (error: unknown) => this.setClassifierLine({ text: errorMessage(error), ready: false }),
    );
  }

  private setClassifierLine(line: ClassifierLine): void {
    this.classifierLine = line;
    if (!this.settled) this.render();
  }

  private async rescan(): Promise<void> {
    this.state = createTypeWeaveState(await this.actions.rescan(), this.state);
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
        await this.rescan();
        if (!control.signal.aborted) new Notice(formatTypeClassifyNotice(result));
      } catch (error) {
        if (control.signal.aborted) return;
        new Notice(`Type check failed: ${errorMessage(error)}`);
        try {
          await this.rescan();
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
    const rows = this.state.rows;
    this.titleEl.setText(`Review ${rows.length} note ${rows.length === 1 ? "type" : "types"}`);
    contentEl.createDiv({ text: "Apply sets only the type property of checked notes. A row starts checked only when its type raises no ontology issue." });
    if (rows.length === 0) contentEl.createDiv({ text: "No type proposals to review." });
    for (const row of rows) {
      const setting = new Setting(contentEl).setName(row.path).setDesc(rowDescription(row));
      const check = setting.controlEl.createEl("input", { attr: { type: "checkbox" } });
      check.checked = row.checked;
      check.addEventListener("change", () => {
        this.state = toggleRow(this.state, row.path, check.checked);
      });
      const select = setting.controlEl.createEl("select");
      for (const type of this.state.proposable) select.createEl("option", { text: type, attr: { value: type } });
      select.value = row.type;
      select.disabled = this.applying;
      select.addEventListener("change", () => {
        this.state = setRowType(this.state, row.path, select.value);
        this.render();
      });
      setting.addButton((b) => b.setButtonText("Dismiss").setDisabled(this.applying).onClick(() => {
        if (this.applying) return;
        void this.actions.dismiss(row.path).then(
          () => {
            this.state = removeRow(this.state, row.path);
            this.render();
          },
          (error: unknown) => new Notice(`Type dismiss failed: ${errorMessage(error)}`),
        );
      }));
    }
    const { noProposal, notShown } = this.state;
    if (notShown > 0) contentEl.createDiv({ text: `${notShown} more ${notShown === 1 ? "row" : "rows"} not shown. Apply, then run this again.` });
    if (noProposal > 0) {
      contentEl.createDiv({ text: `${noProposal} untyped ${noProposal === 1 ? "note has" : "notes have"} no proposal. Check with model to ask for one.` });
    }
    if (this.classifierLine) contentEl.createDiv({ text: this.classifierLine.text });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Check with model").setDisabled(this.checking || this.applying || !this.classifierLine?.ready).onClick(() => this.runClassify()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => (this.applying ? this.close() : this.finish(null))))
      .addButton((b) => b.setButtonText("Apply selected").setCta().setDisabled(this.checking || this.applying).onClick(() => {
        if (this.applying || this.checking || this.settled) return;
        this.applying = true;
        this.render();
        void this.actions.apply(selectedTypes(this.state)).then(
          (result) => this.finish(result),
          (error: unknown) => {
            new Notice(`Type weave failed: ${errorMessage(error)}`);
            this.finish(null);
          },
        );
      }));
  }

  private finish(result: TypeApplyResult | null): void {
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
