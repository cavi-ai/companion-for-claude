import { FuzzySuggestModal, Notice, type App } from "obsidian";
import type { CliModel } from "../cli/modelDiscovery";
import { cliModelChoices } from "./cliModelChoices";

const CUSTOM = "__companion_custom_model__";

/** Search is essential for OpenCode's provider-qualified catalog. */
export class CliModelPicker extends FuzzySuggestModal<CliModel> {
  private models: CliModel[] = [];
  private disposed = false;

  constructor(app: App, private label: string, private current: string, private load: () => Promise<CliModel[]>, private choose: (id: string) => void, private custom: () => void) {
    super(app);
    this.setPlaceholder(`Search ${label} models…`);
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    try {
      const models = await this.load();
      if (this.disposed) return;
      this.models = models;
      this.inputEl.dispatchEvent(new Event("input"));
    } catch (error: unknown) {
      if (!this.disposed) new Notice(`Couldn’t detect ${this.label} models: ${error instanceof Error ? error.message : String(error)}. Use the default or a custom model in settings.`);
    }
  }

  override getItems(): CliModel[] {
    return [...cliModelChoices(this.models, this.current, this.label), { id: CUSTOM, label: "Custom model…" }];
  }

  override getItemText(item: CliModel): string { return item.label; }

  override onChooseItem(item: CliModel): void {
    if (item.id === CUSTOM) this.custom();
    else this.choose(item.id);
  }

  override onClose(): void { this.disposed = true; super.onClose(); }
}
