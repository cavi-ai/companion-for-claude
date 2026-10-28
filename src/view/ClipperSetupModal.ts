import { App, Modal } from "obsidian";
import type { ClipperSetupViewModel } from "../sources/clipperSetup";
import type { SourceType } from "../sources/types";
import type { ClipperJsonFile } from "../sources/clipperJsonFile";

export interface ClipperSetupModalDependencies {
  setups(): ClipperSetupViewModel[];
  copyText(text: string): void | Promise<void>;
  onCopied(type: SourceType, fingerprint: string): void | Promise<void>;
  saveJson?(artifact: ClipperJsonFile): boolean | void | Promise<boolean | void>;
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

    const status = setup.status === "verified"
      ? "Verified — a clip matched this template"
      : setup.status === "not-set-up" ? "Not set up" : setup.status === "update-available" ? "Update available" : "Template exported — import and create a test clip";
    this.contentEl.createDiv({ cls: "cc-clipper-status", text: status });
    const summary = this.contentEl.createDiv({ cls: "cc-clipper-summary" });
    summary.createDiv({ text: `Template: ${setup.templateName}` });
    summary.createDiv({ text: `Destination: ${setup.destination}` });
    summary.createDiv({ text: `Source schema version: ${setup.schemaVersion}` });

    const fields = this.contentEl.createDiv({ cls: "cc-clipper-fields" });
    fields.createEl("h3", { text: "Web Clipper stamps" });
    fields.createEl("p", { text: setup.pageKnownFields.join(", ") || "Page URL and capture date" });
    fields.createEl("h3", { text: "Companion enriches" });
    fields.createEl("p", { text: setup.companionFields.join(", ") || "No additional fields" });

    this.contentEl.createEl("h3", { text: "Templates → Import" });
    this.contentEl.createEl("p", { text: "Install this clipping template in Templates. The Properties importer requires the separate property types file below." });
    this.contentEl.createEl("pre", { cls: "cc-clipper-json cc-clipper-template-json", text: setup.json });
    this.contentEl.createEl("p", { cls: "cc-clipper-instructions", text: setup.instructions });
    const verification = this.contentEl.createDiv({
      cls: "cc-clipper-verification",
      text: "Waiting for a test clip after you copy this template.",
      attr: { role: "status", "aria-live": "polite" },
    });
    const actions = this.contentEl.createDiv({ cls: "cc-clipper-actions" });
    // File export and text import use the same validated JSON artifact.
    if (this.deps.saveJson) {
      const save = actions.createEl("button", { cls: "mod-cta", text: "Save JSON file" });
      save.addEventListener("click", () => void this.save(setup, verification));
    }
    const copyJson = actions.createEl("button", { text: "Copy template JSON" });
    copyJson.addEventListener("click", () => void this.copy(setup, setup.json, verification));
    const copyInstructions = actions.createEl("button", { text: "Copy instructions" });
    copyInstructions.addEventListener("click", () => void this.copyInstructions(setup.instructions, verification));

    const properties = this.contentEl.createEl("details");
    properties.createEl("summary", { text: "Property types — Properties → Import" });
    properties.createEl("p", { text: "Optional: import these property types in Web Clipper → Settings → Properties → Import. This sets property types only; install the template above to clip pages. Web Clipper asks before changing conflicting property types." });
    properties.createEl("pre", { cls: "cc-clipper-json cc-clipper-properties-json", text: setup.propertyTypesFile.json });
    const propertyStatus = properties.createDiv({ cls: "cc-clipper-properties-status", attr: { role: "status", "aria-live": "polite" } });
    const propertyActions = properties.createDiv({ cls: "cc-clipper-actions" });
    if (this.deps.saveJson) {
      propertyActions.createEl("button", { text: "Save property types JSON" })
        .addEventListener("click", () => void this.save(setup, propertyStatus, "Properties"));
    }
    propertyActions.createEl("button", { text: "Copy property types JSON" })
      .addEventListener("click", () => void this.copy(setup, setup.propertyTypesFile.json, propertyStatus, "Properties"));
  }

  private async save(setup: ClipperSetupViewModel, status: HTMLElement, target: "Templates" | "Properties" = "Templates"): Promise<void> {
    try {
      if (await this.deps.saveJson?.(target === "Properties" ? setup.propertyTypesFile : setup) === false) {
        status.setText("File export cancelled. You can save again or copy template JSON.");
        return;
      }
      if (target === "Templates") await this.deps.onCopied(setup.type, setup.fingerprint);
      status.setText(target === "Properties"
        ? "Saved property types. Import this file in Properties → Import; install the clipping template separately."
        : "Saved. Import that file in Templates → Import — waiting for a matching test clip.");
    } catch (error) {
      status.setText(error instanceof Error ? error.message : "The JSON file could not be saved.");
    }
  }

  private async copy(setup: ClipperSetupViewModel, value: string, status: HTMLElement, target: "Templates" | "Properties" = "Templates"): Promise<void> {
    try {
      await this.deps.copyText(value);
      if (target === "Templates") await this.deps.onCopied(setup.type, setup.fingerprint);
      status.setText(target === "Properties"
        ? "Copied property types. Paste in Properties → Import; install the clipping template separately."
        : "Copied. In Web Clipper → Templates → Import → JSON, paste this template, then create a test clip.");
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
