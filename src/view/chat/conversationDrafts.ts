import type { Composer } from "./Composer";
import { draftSourcesState, readDraftContext, restoreDraftContext, type DraftSources } from "./draftContextState";

type Draft = { text: string; sources: DraftSources };
function copySources(sources: DraftSources): DraftSources {
  return { attachedPaths: [...sources.attachedPaths], attachedMedia: [...sources.attachedMedia], attachedPages: [...sources.attachedPages] };
}
function emptySources(): DraftSources {
  return { attachedPaths: [], attachedMedia: [], attachedPages: [] };
}

/** Unsent questions and selected sources in one pane; null owns its unstarted New chat draft. */
export class ConversationDrafts {
  generation = 0;
  private readonly drafts = new Map<string | null, Draft>();

  constructor(private readonly composer: () => Composer) {}

  switchTo(from: string | null, to: string | null): void {
    this.generation++;
    if (from === to) {
      if (to === null) Object.assign(this.composer(), emptySources());
      return;
    }
    const draft = this.capture();
    if (draft.text || draft.sources.attachedPaths.length || draft.sources.attachedMedia.length || draft.sources.attachedPages.length) this.drafts.set(from, draft);
    else this.drafts.delete(from);
    this.display(to);
  }

  getState(conversationId: string | null): Record<string, unknown> {
    const drafts = new Map(this.drafts);
    drafts.set(conversationId, this.capture());
    const entries = [...drafts].flatMap(([id, draft]) => {
      const sources = draftSourcesState(draft.sources);
      const hasSources = sources.paths.length || sources.media.length || sources.pages.length;
      // The current context stays at the top level for older workspace layouts.
      const context = id !== conversationId && hasSources ? { context: sources } : {};
      if (!draft.text && !("context" in context)) return [];
      return [{ conversationId: id, text: draft.text, ...context }];
    });
    return { conversationId, ...(entries.length ? { drafts: entries } : {}) };
  }

  restore(state: unknown, conversationId: string | null): void {
    const entries = (state as { drafts?: unknown } | null)?.drafts;
    if (Array.isArray(entries)) {
      this.generation++;
      this.drafts.clear();
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const { conversationId, text } = entry as Record<string, unknown>;
        if ((conversationId === null || typeof conversationId === "string") && typeof text === "string") {
          const fallback = { contextToggles: this.composer().contextToggles, ...emptySources() };
          this.drafts.set(conversationId, { text, sources: copySources(readDraftContext(fallback, entry) ?? fallback) });
        }
      }
      this.display(conversationId);
    }
    restoreDraftContext(this.composer(), state);
  }

  private capture(): Draft {
    const composer = this.composer();
    return { text: composer.draft(), sources: copySources(composer) };
  }

  private display(conversationId: string | null): void {
    const composer = this.composer();
    const draft = this.drafts.get(conversationId);
    Object.assign(composer, copySources(draft?.sources ?? emptySources()));
    composer.renderContextManager();
    if (!composer.inputEl) return;
    composer.inputEl.value = draft?.text ?? "";
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
