import { App, Modal } from "obsidian";

export interface FrontmatterProposal {
  type?: string;
  tags: string[];
  summary?: string;
}

/**
 * Preview + confirm for the per-note "/frontmatter" suggestion. Nothing is
 * written unless the user clicks Apply; closing counts as Cancel. The proposal
 * merges additively (see main.suggestFrontmatterForActiveNote), so this only
 * ever shows fields that would be added or unioned — never a destructive rewrite.
 */
export class FrontmatterModal extends Modal {
  private applied = false;

  constructor(
    app: App,
    private noteName: string,
    private proposal: FrontmatterProposal,
    private via: string,
    private onDone: (apply: boolean) => void | Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Suggested frontmatter");
    const { contentEl } = this;
    contentEl.addClass("cc-fm-modal");
    contentEl.createDiv({ cls: "cc-fm-note", text: this.noteName });

    const rows = contentEl.createDiv({ cls: "cc-fm-rows" });
    const row = (key: string, value: string) => {
      const r = rows.createDiv({ cls: "cc-fm-row" });
      r.createSpan({ cls: "cc-fm-key", text: key });
      r.createSpan({ cls: "cc-fm-val", text: value });
    };
    if (this.proposal.type) row("type", this.proposal.type);
    if (this.proposal.tags.length) row("tags", this.proposal.tags.join(", "));
    if (this.proposal.summary) row("summary", this.proposal.summary);

    contentEl.createDiv({
      cls: "cc-fm-via",
      text: `via ${this.via} · merges additively — nothing you already set is removed`,
    });

    const buttons = contentEl.createDiv({ cls: "cc-fm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const apply = buttons.createEl("button", { text: "Apply", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      this.applied = true;
      this.close();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    void this.onDone(this.applied);
  }
}
