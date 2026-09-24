import { FuzzySuggestModal, type FuzzyMatch, type App } from "obsidian";
import type { ChatProject } from "./model";

/** Fuzzy picker over available chat projects for the "Chat: choose project" command. */
export class ProjectPicker extends FuzzySuggestModal<ChatProject> {
  constructor(
    app: App,
    private projects: ChatProject[],
    private onChoose: (project: ChatProject) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a chat project…");
  }

  override getItems(): ChatProject[] {
    return this.projects;
  }

  override getItemText(item: ChatProject): string {
    return item.name;
  }

  override renderSuggestion(match: FuzzyMatch<ChatProject>, el: HTMLElement): void {
    const p = match.item;
    el.addClass("cc-project-suggestion");
    el.createDiv({ cls: "cc-project-suggestion-name", text: p.name });
    if (p.folder) el.createDiv({ cls: "cc-project-suggestion-folder", text: p.folder });
  }

  override onChooseItem(item: ChatProject): void {
    this.onChoose(item);
  }
}
