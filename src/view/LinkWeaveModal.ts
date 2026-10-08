import { App, Modal, Notice, Setting } from "obsidian";
import type { LinkApplyResult } from "../optimize/linkController";
import type { LinkProposal, LinkScanReport } from "../optimize/linkScan";
import { createLinkWeaveState, kindLabel, removeRow, selectedProposals, toggleRow, type LinkWeaveViewState } from "./linkWeaveState";
import { errorMessage } from "../records";

export interface LinkWeaveActions {
  apply(selected: LinkProposal[]): Promise<LinkApplyResult>;
  dismiss(proposal: LinkProposal): Promise<void>;
}

/** Review gate for orphan links: nothing is written until Apply. */
export class LinkWeaveModal extends Modal {
  private state: LinkWeaveViewState;
  private settled = false;
  private applying = false;

  constructor(
    app: App,
    report: Pick<LinkScanReport, "groups" | "remaining">,
    private actions: LinkWeaveActions,
    private onDone: (result: LinkApplyResult | null) => void,
  ) {
    super(app);
    this.state = createLinkWeaveState(report.groups, report.remaining);
  }

  override onOpen(): void {
    this.contentEl.addClass("cc-link-weave-review");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const rows = this.state.rows;
    this.titleEl.setText(`Review ${rows.length} link ${rows.length === 1 ? "proposal" : "proposals"}`);
    contentEl.createDiv({ text: "Mention rows rewrite the first mention in the note as a link. Related rows add a link to the note's related property. Related rows start unchecked." });
    if (rows.length === 0) contentEl.createDiv({ text: "No orphan notes to connect." });
    let lastOrphan = "";
    for (const row of rows) {
      const p = row.proposal;
      if (p.orphan !== lastOrphan) {
        lastOrphan = p.orphan;
        contentEl.createEl("h4", { text: p.orphan, cls: "cc-link-weave-orphan" });
      }
      const setting = new Setting(contentEl)
        .setName(`${kindLabel(p)}: ${p.source} → ${p.target}`)
        .setDesc(p.mention?.excerpt ?? "");
      const check = setting.controlEl.createEl("input", { attr: { type: "checkbox" } });
      check.checked = row.checked;
      check.addEventListener("change", () => {
        this.state = toggleRow(this.state, p.id, check.checked);
      });
      setting.addButton((b) => b.setButtonText("Dismiss").setDisabled(this.applying).onClick(() => {
        if (this.applying) return;
        void this.actions.dismiss(p).then(
          () => {
            this.state = removeRow(this.state, p.id);
            this.render();
          },
          (error: unknown) => new Notice(`Link dismiss failed: ${errorMessage(error)}`),
        );
      }));
    }
    if (this.state.remaining > 0) {
      contentEl.createDiv({ text: `${this.state.remaining} more orphan ${this.state.remaining === 1 ? "note" : "notes"} not shown. Apply, then run this again.` });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => (this.applying ? this.close() : this.finish(null))))
      .addButton((b) => b.setButtonText("Apply selected").setCta().setDisabled(this.applying).onClick(() => {
        if (this.applying || this.settled) return;
        this.applying = true;
        this.render();
        void this.actions.apply(selectedProposals(this.state)).then(
          (result) => this.finish(result),
          (error: unknown) => {
            new Notice(`Link weave failed: ${errorMessage(error)}`);
            this.finish(null);
          },
        );
      }));
  }

  private finish(result: LinkApplyResult | null): void {
    this.applying = false;
    if (!this.settled) {
      this.settled = true;
      this.onDone(result);
    }
    this.close();
  }

  override onClose(): void {
    if (!this.settled && !this.applying) {
      this.settled = true;
      this.onDone(null);
    }
  }
}
