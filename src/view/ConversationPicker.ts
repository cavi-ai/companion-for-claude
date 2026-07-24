import { FuzzySuggestModal, type FuzzyMatch, type App, setIcon } from "obsidian";
import { type Conversation, relativeTime } from "../conversations/store";

/**
 * Fuzzy picker over saved conversations, most-recent first. Calls `onChoose`
 * with the selected conversation so the chat view can resume it; the per-row
 * trash button (two-tap confirm) calls `onDelete`.
 */
export class ConversationPicker extends FuzzySuggestModal<Conversation> {
  constructor(
    app: App,
    private conversations: Conversation[],
    private onChoose: (conversation: Conversation) => void,
    private onDelete?: (conversation: Conversation) => void,
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
    const main = el.createDiv({ cls: "cc-conv-main" });
    main.createDiv({ cls: "cc-conv-title", text: c.title });
    const turns = c.messages.filter((m) => m.role === "user").length;
    main.createDiv({
      cls: "cc-conv-meta",
      text: `${relativeTime(c.updatedAt)} · ${turns} message${turns === 1 ? "" : "s"}`,
    });
    if (this.onDelete) {
      const del = el.createEl("button", { cls: "cc-conv-delete", attr: { "aria-label": `Delete “${c.title}”` } });
      setIcon(del, "trash-2");
      del.addEventListener("click", (e) => {
        // Two-tap confirm: first tap arms, second tap (within 2.5s) deletes.
        e.stopPropagation();
        e.preventDefault();
        if (!del.hasClass("is-armed")) {
          del.addClass("is-armed");
          del.setAttr("aria-label", "Tap again to delete");
          window.setTimeout(() => {
            del.removeClass("is-armed");
            del.setAttr("aria-label", `Delete “${c.title}”`);
          }, 2500);
          return;
        }
        this.close();
        this.onDelete?.(c);
      });
    }
  }

  override onChooseItem(item: Conversation): void {
    this.onChoose(item);
  }
}
