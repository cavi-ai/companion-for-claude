import { FuzzySuggestModal, type App } from "obsidian";
import type { TriageFolderChoice } from "../research/triage";

/**
 * Pick the folder to triage: the known inbox/library choices first, then any
 * other vault folder that holds markdown. Resolves undefined when dismissed.
 */
export class TriageFolderModal extends FuzzySuggestModal<TriageFolderChoice> {
  private resolved = false;

  constructor(
    app: App,
    private readonly choices: TriageFolderChoice[],
    private readonly onPick: (folder: string | undefined) => void,
  ) {
    super(app);
    this.setPlaceholder("Triage which folder?");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "triage" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  override getItems(): TriageFolderChoice[] {
    return this.choices;
  }

  override getItemText(item: TriageFolderChoice): string {
    return item.label;
  }

  override onChooseItem(item: TriageFolderChoice): void {
    this.resolved = true;
    this.onPick(item.folder);
  }

  override onClose(): void {
    super.onClose();
    if (!this.resolved) this.onPick(undefined);
  }
}
