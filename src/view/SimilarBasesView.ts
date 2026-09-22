import { BasesView, NullValue, type QueryController } from "obsidian";
import { SIMILAR_VIEW_MESSAGES, isNoteAnchor, rankWithinBase, similarViewState } from "../bases/similarView";

export const SIMILAR_BASES_VIEW_TYPE = "companion-similar";
const DEFAULT_LIMIT = 20;

export interface SimilarViewDeps {
  semanticEnabled(): boolean;
  related(path: string, k: number, accept?: (path: string) => boolean): Promise<{ path: string; score: number }[]>;
}

export class SimilarBasesView extends BasesView {
  override type = SIMILAR_BASES_VIEW_TYPE;
  private generation = 0;
  /** Sticky: a standalone base tab makes getActiveFile() the .base file, not a note. */
  private anchor: string | null = null;

  constructor(controller: QueryController, private readonly containerEl: HTMLElement, private readonly deps: SimilarViewDeps) {
    super(controller);
  }

  override onload(): void {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.refresh()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (oldPath !== this.anchor) return;
      this.anchor = file.path;
      void this.refresh();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.path !== this.anchor) return;
      this.anchor = null;
      void this.refresh();
    }));
  }

  onDataUpdated(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const active = this.app.workspace.getActiveFile()?.path ?? null;
    if (isNoteAnchor(active)) this.anchor = active;
    const anchor = this.anchor;
    const semanticEnabled = this.deps.semanticEnabled();
    const entries = this.data.data;
    const basePaths = new Set(entries.map((e) => e.file.path));
    const limitOption = Number(this.config.get("limit"));
    const limit = Number.isFinite(limitOption) && limitOption > 0 ? limitOption : DEFAULT_LIMIT;
    let related: { path: string; score: number }[] = [];
    if (semanticEnabled && anchor) {
      try {
        related = await this.deps.related(anchor, limit + 1, (p) => basePaths.has(p) && p !== anchor);
      } catch (e) {
        console.debug("Claude Companion: similar-notes lookup failed", e);
        related = [];
      }
    }
    if (generation !== this.generation) return;
    const byPath = new Map(entries.map((e) => [e.file.path, e]));
    const ranked = anchor ? rankWithinBase(related, basePaths, anchor, limit) : [];
    const state = similarViewState({ semanticEnabled, anchorPath: anchor, relatedCount: related.length, rankedCount: ranked.length });

    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: "cc-similar" });
    if (state !== "ready" || !anchor) {
      root.createDiv({ cls: "cc-similar-empty", text: SIMILAR_VIEW_MESSAGES[state === "ready" ? "no-note" : state] });
      return;
    }
    const order = this.config.getOrder();
    for (const hit of ranked) {
      const entry = byPath.get(hit.path);
      if (!entry) continue;
      const row = root.createDiv({ cls: "cc-similar-row" });
      const link = row.createEl("a", { cls: "cc-similar-link", text: entry.file.basename });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void this.app.workspace.openLinkText(hit.path, anchor);
      });
      row.createSpan({ cls: "cc-similar-score", text: `${Math.round(hit.score * 100)}%` });
      for (const prop of order) {
        const value = entry.getValue(prop);
        if (value === null || value instanceof NullValue) continue;
        const text = value.toString();
        if (text) row.createSpan({ cls: "cc-similar-prop", text: `${this.config.getDisplayName(prop)}: ${text}` });
      }
    }
  }
}
