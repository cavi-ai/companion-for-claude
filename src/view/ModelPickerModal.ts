import { Modal, setIcon, type App } from "obsidian";
import { type ModelChoiceGroup, ModelCatalogSource } from "./chat/modelCatalog";

/** Grouped route picker; discovery adds rows without replacing the focused control. */
export class ModelPickerModal extends Modal {
  private opened = false;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private status!: HTMLElement;
  private groups = new Map<string, { section: HTMLElement; options: HTMLElement }>();
  private rows = new Map<string, { button: HTMLButtonElement; label: HTMLElement; check: HTMLElement; search: string }>();

  constructor(app: App, private source: ModelCatalogSource, private choose: (value: string) => void, private configure: () => void) { super(app); }

  override onOpen(): void {
    this.opened = true;
    this.titleEl.setText("Choose model and backend");
    this.modalEl.addClass("cc-model-picker");
    this.contentEl.addClass("cc-model-picker-content");
    this.input = this.contentEl.createEl("input", { cls: "cc-model-search", attr: { type: "search", placeholder: "Search models or backends…", "aria-label": "Search models or backends" } });
    this.list = this.contentEl.createDiv({ cls: "cc-model-groups" });
    this.status = this.contentEl.createDiv({ cls: "cc-model-discovery-status", attr: { role: "status" } });
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", event => {
      const visible = [...this.rows].filter(([, row]) => !row.button.hidden);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        visible[event.key === "ArrowDown" ? 0 : visible.length - 1]?.[1].button.focus();
      } else if (event.key === "Enter" && visible[0]) {
        event.preventDefault();
        const value = visible[0][0];
        this.close();
        this.choose(value);
      }
    });
    this.list.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = [...this.rows.values()].filter(row => !row.button.hidden).map(row => row.button);
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    });
    const configure = this.contentEl.createEl("button", { cls: "cc-model-configure", text: "Configure models…" });
    configure.addEventListener("click", () => { this.close(); this.configure(); });
    this.renderCatalog(this.source.snapshot());
    this.input.focus();
    void this.source.refresh(groups => this.renderCatalog(groups), () => {
      this.status.setText("Some models could not be refreshed. Your configured models are available.");
    });
  }

  renderCatalog(groups: ModelChoiceGroup[]): void {
    if (!this.opened) return;
    const values = new Set<string>();
    const selected = this.source.selected();
    for (const group of groups) {
      let container = this.groups.get(group.backend);
      if (!container) {
        const section = this.list.createEl("section", { cls: "cc-model-group", attr: { "data-backend": group.backend, "aria-label": group.label } });
        section.createEl("h3", { cls: "cc-model-group-title", text: group.label });
        container = { section, options: section.createDiv({ cls: "cc-model-options" }) };
        this.groups.set(group.backend, container);
      }
      for (const choice of group.choices) {
        values.add(choice.value);
        let row = this.rows.get(choice.value);
        if (!row) {
          const button = container.options.createEl("button", { cls: "cc-model-option", attr: { type: "button", "data-model-value": choice.value } });
          const label = button.createSpan({ cls: "cc-model-option-label" });
          const check = button.createSpan({ cls: "cc-model-option-check", attr: { "aria-hidden": "true" } });
          setIcon(check, "check");
          row = { button, label, check, search: "" };
          this.rows.set(choice.value, row);
          button.addEventListener("click", () => { this.close(); this.choose(choice.value); });
        }
        row.label.setText(choice.label);
        row.search = `${group.label} ${choice.label}`.toLocaleLowerCase();
        row.button.setAttr("aria-pressed", String(choice.value === selected));
        row.button.toggleClass("is-selected", choice.value === selected);
        row.check.hidden = choice.value !== selected;
      }
    }
    for (const [value, row] of this.rows) {
      if (values.has(value)) continue;
      const focused = row.button.ownerDocument.activeElement === row.button;
      row.button.remove();
      this.rows.delete(value);
      if (focused) this.input.focus();
    }
    this.filter();
  }

  private filter(): void {
    const query = this.input.value.trim().toLocaleLowerCase();
    for (const row of this.rows.values()) row.button.hidden = !!query && !row.search.includes(query);
    for (const { section, options } of this.groups.values()) section.hidden = ![...options.children].some(child => !(child as HTMLElement).hidden);
  }

  override onClose(): void {
    this.opened = false;
    this.source.dispose();
    this.rows.clear();
    this.groups.clear();
    this.contentEl.empty();
  }
}
