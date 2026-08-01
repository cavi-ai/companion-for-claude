import { App, Modal, Setting } from "obsidian";
import type { EditPlan } from "../edit/diff";

/** Which enrich steps to run — every step defaults on (full go). */
export interface EnrichOptions {
  rename: boolean;
  frontmatter: boolean;
  links: boolean;
  lint: boolean;
}

/** Everything an enrich pass can propose for one note. */
export interface EnrichProposal {
  path: string;
  rename?: { from: string; to: string } | undefined;
  frontmatter?: { tags: string[]; summary: string; addedTags: string[] } | undefined;
  plan?: EditPlan | undefined;
}

/** What the user accepted — `accepted` aligns with proposal.plan.hunks. */
export interface EnrichDecision {
  rename: boolean;
  frontmatter: boolean;
  accepted: boolean[];
}

/**
 * Step picker for Enrich (note + folder batch): one toggle per step, all on
 * by default; "Enrich" resolves the options, Cancel/close resolves null.
 */
export class EnrichOptionsModal extends Modal {
  private decided = false;
  private options: EnrichOptions = { rename: true, frontmatter: true, links: true, lint: true };

  constructor(
    app: App,
    private count: number,
    private onDone: (options: EnrichOptions | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.count === 1 ? "Enrich note" : `Enrich ${this.count} notes`);
    const { contentEl } = this;

    new Setting(contentEl).setName("Rename note").setDesc("Meaningful filename from a model-generated title.").addToggle((t) =>
      t.setValue(this.options.rename).onChange((v) => {
        this.options.rename = v;
      }),
    );
    new Setting(contentEl).setName("Tags & summary").setDesc("Suggest tags (reusing existing vault tags) and a one-line summary into frontmatter.").addToggle((t) =>
      t.setValue(this.options.frontmatter).onChange((v) => {
        this.options.frontmatter = v;
      }),
    );
    new Setting(contentEl).setName("Add wikilinks").setDesc("Turn unlinked mentions of other notes into [[links]].").addToggle((t) =>
      t.setValue(this.options.links).onChange((v) => {
        this.options.links = v;
      }),
    );
    new Setting(contentEl).setName("Lint note").setDesc("Copyedit pass: spelling, grammar, markdown fixes.").addToggle((t) =>
      t.setValue(this.options.lint).onChange((v) => {
        this.options.lint = v;
      }),
    );

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.decided = true;
          this.onDone(null);
          this.close();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Enrich")
          .setCta()
          .onClick(() => {
            this.decided = true;
            this.onDone({ ...this.options });
            this.close();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.onDone(null);
  }
}

/**
 * Review gate for one note's enrich proposal: rename and frontmatter rows plus
 * per-hunk content diffs, every item checked by default; "Apply selected"
 * resolves the decision, "Cancel"/close resolves null — nothing touches the
 * vault without an explicit apply.
 */
export class EnrichReviewModal extends Modal {
  private applied = false;
  private accepted: boolean[];
  private renameAccepted = true;
  private frontmatterAccepted = true;

  constructor(
    app: App,
    private proposal: EnrichProposal,
    private onDone: (decision: EnrichDecision | null) => void,
  ) {
    super(app);
    this.accepted = (proposal.plan?.hunks ?? []).map(() => true);
  }

  override onOpen(): void {
    this.titleEl.setText(`Enrich — ${this.proposal.path}`);
    const { contentEl } = this;
    contentEl.addClass("cc-diff-modal");

    const { rename, frontmatter, plan } = this.proposal;

    if (rename) {
      const row = contentEl.createDiv({ cls: "cc-organize-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      check.addEventListener("change", () => {
        this.renameAccepted = check.checked;
        row.toggleClass("is-rejected", !check.checked);
      });
      const text = row.createDiv({ cls: "cc-organize-text" });
      text.createDiv({ cls: "cc-organize-from", text: "Rename" });
      text.createDiv({ cls: "cc-organize-to", text: `→ ${rename.to}` });
    }

    if (frontmatter) {
      const row = contentEl.createDiv({ cls: "cc-organize-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      check.addEventListener("change", () => {
        this.frontmatterAccepted = check.checked;
        row.toggleClass("is-rejected", !check.checked);
      });
      const text = row.createDiv({ cls: "cc-organize-text" });
      text.createDiv({ cls: "cc-organize-from", text: "Frontmatter" });
      const bits: string[] = [];
      if (frontmatter.addedTags.length > 0) bits.push(`+tags: ${frontmatter.addedTags.join(", ")}`);
      if (frontmatter.summary) bits.push(`summary: ${frontmatter.summary}`);
      text.createDiv({ cls: "cc-organize-to", text: bits.join(" · ") || "No changes" });
    }

    for (const [i, hunk] of (plan?.hunks ?? []).entries()) {
      const box = contentEl.createDiv({ cls: "cc-diff-hunk" });
      const header = box.createEl("label", { cls: "cc-diff-hunk-header" });
      const check = header.createEl("input", { type: "checkbox" });
      check.checked = true;
      check.addEventListener("change", () => {
        this.accepted[i] = check.checked;
        box.toggleClass("is-rejected", !check.checked);
      });
      header.createSpan({ cls: "cc-diff-hunk-title", text: `Change ${i + 1} — line ${hunk.lineno}` });

      const body = box.createEl("pre", { cls: "cc-diff-lines" });
      for (const line of hunk.lines) {
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        body.createDiv({ cls: `cc-diff-line is-${line.kind}`, text: `${marker} ${line.text}` });
      }
    }

    const buttons = contentEl.createDiv({ cls: "cc-diff-buttons" });
    const apply = buttons.createEl("button", { text: "Apply selected", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      this.applied = true;
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    const anyHunks = this.accepted.some(Boolean);
    const any = (this.proposal.rename && this.renameAccepted) || (this.proposal.frontmatter && this.frontmatterAccepted) || anyHunks;
    this.onDone(
      this.applied && any
        ? { rename: this.renameAccepted && !!this.proposal.rename, frontmatter: this.frontmatterAccepted && !!this.proposal.frontmatter, accepted: this.accepted }
        : null,
    );
  }
}
