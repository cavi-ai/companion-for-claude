import { FuzzySuggestModal, type FuzzyMatch, type App } from "obsidian";
import type { Workflow } from "../workflows/catalog";

/** Fuzzy picker over the Companion's vault workflows (manifests, rollups, …). */
export class WorkflowPicker extends FuzzySuggestModal<Workflow> {
  constructor(
    app: App,
    private workflows: Workflow[],
    private onChoose: (workflow: Workflow) => void,
  ) {
    super(app);
    this.setPlaceholder("Run a vault workflow…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "run" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  override getItems(): Workflow[] {
    return this.workflows;
  }

  override getItemText(item: Workflow): string {
    // Include group + description so all of it participates in fuzzy matching.
    return `${item.name} ${item.group} ${item.description}`;
  }

  override renderSuggestion(match: FuzzyMatch<Workflow>, el: HTMLElement): void {
    const w = match.item;
    el.addClass("cc-conv-suggestion");
    el.createDiv({ cls: "cc-conv-title", text: w.name });
    el.createDiv({ cls: "cc-conv-meta", text: `${w.group} · ${w.description}` });
  }

  override onChooseItem(item: Workflow): void {
    this.onChoose(item);
  }
}
