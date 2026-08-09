import { App, Modal } from "obsidian";
import type { ClipperSetupViewModel } from "../sources/clipperSetup";
import type { SourceType } from "../sources/types";

export interface ClipperSetupModalDependencies {
  setups(): ClipperSetupViewModel[];
  copyText(text: string): void | Promise<void>;
  onCopied(type: SourceType, fingerprint: string): void | Promise<void>;
  saveJson?(setup: ClipperSetupViewModel): void | Promise<void>;
}

export class ClipperSetupModal extends Modal {
  private active: SourceType = "article";

  constructor(app: App, private readonly deps: ClipperSetupModalDependencies) { super(app); }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const setups = this.deps.setups();
    const setup = setups.find(({ type }) => type === this.active) ?? setups[0];
    this.contentEl.empty();
    this.contentEl.addClass("cc-clipper-setup-modal");
    this.titleEl.setText("Set up Obsidian Web Clipper");
    if (!setup) {
      this.contentEl.createEl("p", { text: "No source schemas are available." });
      return;
    }
    const tabs = this.contentEl.createDiv({ cls: "cc-clipper-tabs", attr: { role: "tablist", "aria-label": "Clipper schema" } });
    for (const item of setups) {
      const tab = tabs.createEl("button", {
        cls: `cc-clipper-tab${item.type === setup.type ? " is-active" : ""}`,
        text: item.type[0]!.toUpperCase() + item.type.slice(1),
        attr: { role: "tab", "aria-selected": String(item.type === setup.type) },
      });
      tab.addEventListener("click", () => { this.active = item.type; this.render(); });
    }

    const status = setup.status === "not-set-up" ? "Not set up" : setup.status === "update-available" ? "Update available" : "Current template copied";
    this.contentEl.createDiv({ cls: "cc-clipper-status", text: status });
    const summary = this.contentEl.createDiv({ cls: "cc-clipper-summary" });
    summary.createDiv({ text: `Template: ${setup.templateName}` });
    summary.createDiv({ text: `Destination: ${setup.destination}` });
    summary.createDiv({ text: `Schema version: ${setup.schemaVersion}` });

    const fields = this.contentEl.createDiv({ cls: "cc-clipper-fields" });
    fields.createEl("h3", { text: "Web Clipper stamps" });
    fields.createEl("p", { text: setup.pageKnownFields.join(", ") || "Page URL and capture date" });
    fields.createEl("h3", { text: "Companion enriches" });
    fields.createEl("p", { text: setup.companionFields.join(", ") || "No additional fields" });

    this.contentEl.createEl("pre", { cls: "cc-clipper-json", text: setup.json });
    this.contentEl.createEl("p", { cls: "cc-clipper-instructions", text: setup.instructions });
    const verification = this.contentEl.createDiv({
      cls: "cc-clipper-verification",
      text: "Waiting for a test clip after you copy this template.",
      attr: { role: "status", "aria-live": "polite" },
    });
    const actions = this.contentEl.createDiv({ cls: "cc-clipper-actions" });
    const copyJson = actions.createEl("button", { cls: "mod-cta", text: "Copy template JSON" });
    copyJson.addEventListener("click", () => void this.copy(setup, setup.json, verification));
    const copyInstructions = actions.createEl("button", { text: "Copy instructions" });
    copyInstructions.addEventListener("click", () => void this.copyInstructions(setup.instructions, verification));
    if (this.deps.saveJson) {
      const save = actions.createEl("button", { text: "Save JSON file" });
      save.addEventListener("click", () => void Promise.resolve(this.deps.saveJson?.(setup)).catch((error: unknown) => {
        verification.setText(error instanceof Error ? error.message : "The JSON file could not be saved.");
      }));
    }
  }

  private async copy(setup: ClipperSetupViewModel, value: string, status: HTMLElement): Promise<void> {
    try {
      await this.deps.copyText(value);
      await this.deps.onCopied(setup.type, setup.fingerprint);
      status.setText("Copied. Waiting for a matching test clip in the Inbox.");
    } catch (error) {
      status.setText(error instanceof Error ? error.message : "The template could not be copied.");
    }
  }

  private async copyInstructions(value: string, status: HTMLElement): Promise<void> {
    try {
      await this.deps.copyText(value);
      status.setText("Instructions copied.");
    } catch (error) {
      status.setText(error instanceof Error ? error.message : "The instructions could not be copied.");
    }
  }
}
