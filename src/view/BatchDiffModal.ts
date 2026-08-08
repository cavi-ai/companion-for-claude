import { App, Modal } from "obsidian";
import type { BatchLinkPlan, BatchLinkSelection } from "../links/batch";
import {
  batchDiffCounts,
  batchFileSelection,
  createBatchDiffState,
  toggleBatchFile,
  toggleBatchHunk,
  type BatchDiffState,
} from "./batchDiffState";

interface FileControls {
  fileCheckbox: HTMLInputElement;
  hunkCheckboxes: HTMLInputElement[];
  hunkBoxes: HTMLElement[];
}

/**
 * Reviews link proposals across several notes. Closing without an explicit
 * apply fails closed; the caller receives exactly one boolean row per plan.
 */
export class BatchDiffModal extends Modal {
  private state: BatchDiffState;
  private applied = false;
  private countEl: HTMLElement | null = null;
  private controls: FileControls[] = [];

  constructor(
    app: App,
    private readonly plans: BatchLinkPlan[],
    private readonly onDone: (selected: BatchLinkSelection | null) => void,
  ) {
    super(app);
    this.state = createBatchDiffState(plans);
  }

  override onOpen(): void {
    this.titleEl.setText("Review suggested links");
    const { contentEl } = this;
    contentEl.addClass("cc-batch-diff-modal");

    const toolbar = contentEl.createDiv({ cls: "cc-batch-diff-toolbar" });
    this.countEl = toolbar.createSpan({ cls: "cc-batch-diff-count" });

    for (const [fileIndex, item] of this.plans.entries()) {
      const file = contentEl.createDiv({ cls: "cc-batch-diff-file" });
      const header = file.createDiv({ cls: "cc-batch-diff-file-header" });
      const fileToggle = header.createEl("label", {
        cls: "cc-batch-diff-file-toggle",
      });
      const fileCheckbox = fileToggle.createEl("input", {
        cls: "cc-batch-diff-file-checkbox",
        attr: { type: "checkbox", "aria-label": "Select all changes in " + item.path },
      });
      header.createSpan({ cls: "cc-batch-diff-file-path", text: item.path });
      header.createSpan({
        cls: "cc-batch-diff-file-count",
        text: item.plan.hunks.length + " change" + (item.plan.hunks.length === 1 ? "" : "s"),
      });

      const details = file.createEl("details", { cls: "cc-batch-diff-details" });
      details.createEl("summary", {
        cls: "cc-batch-diff-summary",
        text: "Review changes",
        attr: { "aria-label": `Review changes in ${item.path}` },
      });
      const body = details.createDiv({ cls: "cc-batch-diff-body" });
      const hunkCheckboxes: HTMLInputElement[] = [];
      const hunkBoxes: HTMLElement[] = [];

      for (const [hunkIndex, hunk] of item.plan.hunks.entries()) {
        const box = body.createDiv({ cls: "cc-diff-hunk cc-batch-diff-hunk" });
        const hunkHeader = box.createEl("label", { cls: "cc-diff-hunk-header" });
        const hunkCheckbox = hunkHeader.createEl("input", {
          attr: { type: "checkbox", "aria-label": "Select change " + (hunkIndex + 1) + " in " + item.path },
        });
        hunkHeader.createSpan({ cls: "cc-diff-hunk-title", text: "Change " + (hunkIndex + 1) + " — line " + hunk.lineno });

        const lines = box.createEl("pre", { cls: "cc-diff-lines" });
        for (const line of hunk.lines) {
          const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
          lines.createDiv({ cls: "cc-diff-line is-" + line.kind, text: marker + " " + line.text });
        }

        hunkCheckbox.addEventListener("change", () => {
          this.state = toggleBatchHunk(this.state, fileIndex, hunkIndex, hunkCheckbox.checked);
          this.renderSelection();
        });
        hunkCheckboxes.push(hunkCheckbox);
        hunkBoxes.push(box);
      }

      fileCheckbox.addEventListener("change", () => {
        this.state = toggleBatchFile(this.state, fileIndex, fileCheckbox.checked);
        this.renderSelection();
      });
      this.controls.push({ fileCheckbox, hunkCheckboxes, hunkBoxes });
    }

    const buttons = contentEl.createDiv({ cls: "cc-diff-buttons cc-batch-diff-buttons" });
    const apply = buttons.createEl("button", { text: "Apply selected", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      this.applied = true;
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    this.renderSelection();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onDone(this.applied ? this.state.selected.map((file) => [...file]) : null);
  }

  private renderSelection(): void {
    const counts = batchDiffCounts(this.state);
    if (this.countEl) {
      this.countEl.setText(
        counts.selectedFiles + " file" + (counts.selectedFiles === 1 ? "" : "s") + " · " + counts.selectedHunks + " selected",
      );
    }
    for (const [fileIndex, controls] of this.controls.entries()) {
      const fileSelection = batchFileSelection(this.state, fileIndex);
      controls.fileCheckbox.checked = fileSelection.checked;
      controls.fileCheckbox.indeterminate = fileSelection.indeterminate;
      controls.fileCheckbox.setAttr("aria-checked", fileSelection.indeterminate ? "mixed" : String(fileSelection.checked));
      const selected = this.state.selected[fileIndex] ?? [];
      for (const [hunkIndex, checkbox] of controls.hunkCheckboxes.entries()) {
        const checked = selected[hunkIndex] ?? false;
        checkbox.checked = checked;
        controls.hunkBoxes[hunkIndex]?.toggleClass("is-rejected", !checked);
      }
    }
  }
}
