import type { Composer } from "./Composer";

/** Unsent text in one pane; null owns its unstarted New chat draft. */
export class ConversationDrafts {
  generation = 0;
  private readonly drafts = new Map<string | null, string>();

  constructor(private readonly composer: () => Composer) {}

  switchTo(from: string | null, to: string | null): void {
    this.generation++;
    if (from === to) return;
    const composer = this.composer();
    const text = composer.draft();
    if (text) this.drafts.set(from, text);
    else this.drafts.delete(from);
    if (!composer.inputEl) return;
    composer.inputEl.value = this.drafts.get(to) ?? "";
    composer.autosizeInput();
    composer.slashMenu?.hide();
    composer.atMenu?.hide();
    if (composer.pageOfferEl) composer.syncPageOffer();
  }

  /** Consume only the submitted conversation's draft, including a first send. */
  consume(conversationId: string | null): void {
    this.drafts.delete(conversationId);
  }
}
