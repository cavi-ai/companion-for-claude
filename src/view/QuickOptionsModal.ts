import { App, Modal } from "obsidian";
import {
  quickOptionsFor,
  type CompanionPage,
  type QuickOptionAction,
  type QuickOptionChange,
  type QuickOptionDefinition,
  type QuickOptionsState,
} from "./quickOptions";

export interface QuickOptionsModalDependencies {
  snapshot(): QuickOptionsState;
  save(change: QuickOptionChange): void | Promise<void>;
  run(action: QuickOptionAction): void | Promise<void>;
  openAllSettings(): void;
  openDesktopIntegrations(): void;
}

const pageLabel = (page: CompanionPage): string => ({
  chat: "Chat",
  inbox: "Source Inbox",
  related: "Related Notes",
  memory: "Session Memory",
  "research-desk": "Research Desk",
  "research-workbench": "Research Workbench",
})[page];

export class QuickOptionsModal extends Modal {
  constructor(
    app: App,
    private readonly page: CompanionPage,
    private readonly deps: QuickOptionsModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Quick options · ${pageLabel(this.page)}`);
    this.contentEl.empty();
    this.contentEl.addClass("cc-quick-options-modal");
    const error = this.contentEl.createDiv({
      cls: "cc-quick-options-error",
      attr: { role: "alert", "aria-live": "polite" },
    });
    const options = quickOptionsFor(this.page, this.deps.snapshot());
    for (const option of options) this.renderOption(option, error);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderOption(option: QuickOptionDefinition, error: HTMLElement): void {
    if (option.id === "desktop-integrations") {
      const button = this.contentEl.createEl("button", {
        cls: "cc-quick-options-desktop-integrations",
        text: option.label,
      });
      button.addEventListener("click", () => {
        this.close();
        this.deps.openDesktopIntegrations();
      });
      return;
    }
    if (option.id === "all-settings") {
      const button = this.contentEl.createEl("button", {
        cls: "cc-quick-options-all-settings",
        text: option.label,
      });
      button.addEventListener("click", () => {
        this.close();
        this.deps.openAllSettings();
      });
      return;
    }

    const row = this.contentEl.createDiv({ cls: `cc-quick-option is-${option.kind}` });
    const label = row.createDiv({ cls: "cc-quick-option-label", text: option.label });
    if (option.description) row.createDiv({ cls: "cc-quick-option-description", text: option.description });

    if (option.kind === "toggle") {
      const input = row.createEl("input", {
        attr: { type: "checkbox", "aria-label": option.label },
      });
      input.type = "checkbox";
      input.checked = option.value === true;
      input.addEventListener("change", () => this.save({ id: option.id, value: input.checked }, error));
      return;
    }
    if (option.kind === "select") {
      const select = row.createEl("select", { attr: { "aria-label": option.label } });
      for (const choice of option.choices ?? []) {
        select.createEl("option", { text: choice.label, attr: { value: choice.value } });
      }
      select.value = String(option.value ?? "");
      select.addEventListener("change", () => this.save({ id: option.id, value: select.value }, error));
      return;
    }
    if (option.kind === "text") {
      const input = row.createEl("input", {
        attr: { type: "text", "aria-label": option.label },
      });
      input.value = String(option.value ?? "");
      input.addEventListener("change", () => this.save({ id: option.id, value: input.value }, error));
      return;
    }
    if (option.kind === "status") {
      row.createDiv({ cls: "cc-quick-option-value", text: String(option.value ?? "") });
      if (option.actionLabel) {
        const action = row.createEl("button", { text: option.actionLabel });
        action.addEventListener("click", () => this.run(option.id, error));
      }
      label.setAttr("aria-label", `${option.label}: ${String(option.value ?? "")}`);
      return;
    }
    const action = row.createEl("button", { text: option.label, attr: { "aria-label": option.label } });
    action.addEventListener("click", () => this.run(option.id, error));
  }

  private save(change: QuickOptionChange, error: HTMLElement): void {
    error.empty();
    void Promise.resolve(this.deps.save(change)).catch((cause: unknown) => {
      error.setText(cause instanceof Error ? cause.message : "That setting could not be saved.");
    });
  }

  private run(id: string, error: HTMLElement): void {
    error.empty();
    void Promise.resolve(this.deps.run({ id, page: this.page })).catch((cause: unknown) => {
      error.setText(cause instanceof Error ? cause.message : "That action could not be completed.");
    });
  }
}
