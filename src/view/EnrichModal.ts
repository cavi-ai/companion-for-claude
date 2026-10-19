import { App, Modal, Setting } from "obsidian";
import type { EditPlan } from "../edit/diff";
import { formatTagList } from "../tags/label";

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
  failures?: Array<{ step: string; message: string }>;
  rename?: { from: string; to: string } | undefined;
  frontmatter?: { tags: string[]; summary: string; addedTags: string[]; newTags: string[] } | undefined;
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
 * by default; "Tidy" resolves the options, Cancel/close resolves null.
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
    this.titleEl.setText(this.count === 1 ? "Tidy note" : `Tidy ${this.count} notes`);
    const { contentEl } = this;

    const steps = [
      { key: "rename", name: "Rename note", description: "Meaningful filename from a model-generated title." },
      { key: "frontmatter", name: "Tags & summary", description: "Suggest tags (reusing existing vault tags) and a one-line summary into frontmatter." },
      { key: "links", name: "Add wikilinks", description: "Turn unlinked mentions of other notes into [[links]]." },
      { key: "lint", name: "Lint note", description: "Copyedit pass: spelling, grammar, markdown fixes." },
    ] as const;
    for (const { key, name, description } of steps) {
      new Setting(contentEl).setName(name).setDesc(description).addToggle((toggle) => {
        toggle.toggleEl.setAttr("role", "switch");
        toggle.toggleEl.setAttr("aria-label", name);
        toggle.toggleEl.setAttr("aria-description", description);
        toggle.toggleEl.setAttr("aria-checked", String(this.options[key]));
        toggle.toggleEl.querySelector("input")?.setAttr("aria-hidden", "true");
        toggle.setValue(this.options[key]).onChange((value) => {
          this.options[key] = value;
          toggle.toggleEl.setAttr("aria-checked", String(value));
        });
      });
    }

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
          .setButtonText("Tidy")
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
    this.titleEl.setText(`Tidy — ${this.proposal.path}`);
    const { contentEl } = this;
    contentEl.addClass("cc-diff-modal");

    if (this.proposal.failures?.length) {
      const warning = contentEl.createDiv({ attr: { role: "alert" } });
      warning.createEl("p", { text: "Some Tidy steps failed. Review the available changes below, then run Tidy again to retry." });
      for (const { step, message } of this.proposal.failures) warning.createDiv({ text: `${step}: ${message}` });
    }

    const { rename, frontmatter, plan } = this.proposal;

    if (rename) {
      const row = contentEl.createEl("label", { cls: "cc-organize-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      check.addEventListener("change", () => {
        this.renameAccepted = check.checked;
        row.toggleClass("is-rejected", !check.checked);
      });
      const text = row.createSpan({ cls: "cc-organize-text" });
      text.createSpan({ cls: "cc-organize-from", text: "Rename" });
      text.createSpan({ cls: "cc-organize-to", text: `→ ${rename.to}` });
    }

    if (frontmatter) {
      const row = contentEl.createEl("label", { cls: "cc-organize-row" });
      const check = row.createEl("input", { attr: { type: "checkbox" } });
      check.checked = true;
      check.addEventListener("change", () => {
        this.frontmatterAccepted = check.checked;
        row.toggleClass("is-rejected", !check.checked);
      });
      const text = row.createSpan({ cls: "cc-organize-text" });
      text.createSpan({ cls: "cc-organize-from", text: "Frontmatter" });
      const bits: string[] = [];
      if (frontmatter.addedTags.length > 0) bits.push(`+tags: ${formatTagList(frontmatter.addedTags, frontmatter.newTags)}`);
      if (frontmatter.summary) bits.push(`summary: ${frontmatter.summary}`);
      text.createSpan({ cls: "cc-organize-to", text: bits.join(" · ") || "No changes" });
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
