import { FuzzySuggestModal, type FuzzyMatch, type App } from "obsidian";
import { type Conversation, relativeTime } from "../conversations/store";

/**
 * Fuzzy picker over saved conversations, most-recent first. Calls `onChoose`
 * with the selected conversation so the chat view can resume it.
 */
export class ConversationPicker extends FuzzySuggestModal<Conversation> {
  constructor(
    app: App,
    private conversations: Conversation[],
    private onChoose: (conversation: Conversation) => void,
  ) {
    super(app);
    this.setPlaceholder("Resume a conversation…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "resume" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  override getItems(): Conversation[] {
    return this.conversations;
  }

  override getItemText(item: Conversation): string {
    // Include the relative time so it participates in fuzzy matching.
    return `${item.title} ${relativeTime(item.updatedAt)}`;
  }

  override renderSuggestion(match: FuzzyMatch<Conversation>, el: HTMLElement): void {
    const c = match.item;
    el.addClass("cc-conv-suggestion");
    el.createDiv({ cls: "cc-conv-title", text: c.title });
    const turns = c.messages.filter((m) => m.role === "user").length;
    el.createDiv({
      cls: "cc-conv-meta",
      text: `${relativeTime(c.updatedAt)} · ${turns} message${turns === 1 ? "" : "s"}`,
    });
  }

  override onChooseItem(item: Conversation): void {
    this.onChoose(item);
  }
}
