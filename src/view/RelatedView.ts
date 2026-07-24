import { ItemView, WorkspaceLeaf, TFile, MarkdownView, setIcon, debounce } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { findUnlinkedMentions, linkMention, type Mention } from "../links/unlinkedMentions";
import { buildSuggestions } from "../links/suggest";

export const RELATED_VIEW_TYPE = "claude-related-view";

/**
 * Sidebar panel of notes semantically related to the active note (from the local
 * embeddings index). Updates as you navigate. Each row opens the note or inserts
 * a wikilink into the current note.
 */
export class RelatedView extends ItemView {
  /** Avoids redundant re-renders when the active leaf changes but the file doesn't. */
  private shownPath: string | null = null;
  private renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: ClaudeCompanionPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return RELATED_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return "Related notes";
  }
  override getIcon(): string {
    return "git-fork";
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.maybeRender()));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.maybeRender()));
    // Live while writing: refresh suggestions as the active note changes.
    const refresh = debounce(() => void this.render(), 2000, true);
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f.path === this.shownPath) refresh();
      }),
    );
    await this.render();
  }

  /** Re-render only when the active markdown file actually changed. */
  private async maybeRender(): Promise<void> {
    const path = this.app.workspace.getActiveFile()?.path ?? null;
    if (path !== this.shownPath) await this.render();
  }

  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-related-view");

    const file = this.app.workspace.getActiveFile();
    this.shownPath = file?.path ?? null;
    if (!(file instanceof TFile) || file.extension !== "md") {
      root.createEl("div", { cls: "cc-eyebrow", text: "RELATED NOTES" });
      root.createEl("p", { cls: "setting-item-description", text: "Open a note to see what it connects to." });
      return;
    }

    // ---- Link suggestions (pure text — no embeddings needed) ----
    await this.renderSuggestions(root, file, seq);
    if (seq !== this.renderSeq) return;

    root.createEl("div", { cls: "cc-eyebrow", text: "RELATED NOTES" });
    if (!this.plugin.settings.semanticEnabled) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "Turn on “Semantic search” in Companion settings to surface related notes.",
      });
      return;
    }

    root.createEl("div", { cls: "cc-related-for", text: file.basename });
    const loading = root.createEl("p", { cls: "setting-item-description", text: "Finding related notes…" });

    let hits: { path: string; score: number }[];
    try {
      hits = await this.plugin.relatedNotes(file.path, 8);
    } catch {
      if (seq === this.renderSeq) {
        loading.setText(
          this.plugin.settings.embeddingEngine === "builtin"
            ? "Couldn’t compute related notes — download the built-in model in settings."
            : "Couldn’t compute related notes — is Ollama running?",
        );
      }
      return;
    }
    if (seq !== this.renderSeq) return; // a newer render superseded this one
    loading.remove();

    if (hits.length === 0) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "No related notes yet. Rebuild the semantic index (Companion settings), then revisit.",
      });
      return;
    }

    const list = root.createDiv({ cls: "cc-related-list" });
    for (const hit of hits) {
      const target = this.app.vault.getAbstractFileByPath(hit.path);
      const name = target instanceof TFile ? target.basename : hit.path;
      const row = list.createDiv({ cls: "cc-related-row" });

      const open = row.createEl("button", { cls: "cc-related-open", text: name });
      open.addEventListener("click", () => {
        if (target instanceof TFile) void this.app.workspace.getLeaf(false).openFile(target);
      });

      row.createSpan({ cls: "cc-related-score", text: `${Math.round(hit.score * 100)}%` });

      const link = row.createEl("button", {
        cls: "cc-action",
        attr: { "aria-label": `Insert [[${name}]] into ${file.basename}`, title: "Insert link into current note" },
      });
      setIcon(link, "link");
      link.addEventListener("click", () => this.insertLink(file, name));
    }
  }

  /** The "Link suggestions" section: unlinked mentions with one-click linking. */
  private async renderSuggestions(root: HTMLElement, file: TFile, seq: number): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    if (seq !== this.renderSeq) return;
    const mentions = findUnlinkedMentions(content, this.plugin.linkCandidates(), file.path);
    const suggestions = buildSuggestions(mentions, [], this.plugin.linkedTargets(file)).filter((s) => s.mention);
    if (suggestions.length === 0) return;

    root.createEl("div", { cls: "cc-eyebrow", text: "LINK SUGGESTIONS" });
    const list = root.createDiv({ cls: "cc-related-list" });
    for (const s of suggestions) {
      const m = s.mention!;
      const row = list.createDiv({ cls: "cc-related-row" });
      const open = row.createEl("button", { cls: "cc-related-open", text: s.name });
      open.setAttr("title", `Line ${m.line}: ${m.excerpt}`);
      open.addEventListener("click", () => {
        const target = this.app.vault.getAbstractFileByPath(s.path);
        if (target instanceof TFile) void this.app.workspace.getLeaf(false).openFile(target);
      });
      const link = row.createEl("button", {
        cls: "cc-action",
        attr: { "aria-label": `Link "${m.surface}" on line ${m.line}`, title: `Link mention on line ${m.line}` },
      });
      setIcon(link, "link-2");
      link.addEventListener("click", () => void this.applyMention(file, m));
    }
    if (suggestions.length > 1) {
      const all = root.createEl("button", { cls: "cc-related-link-all", text: `Review & link all (${suggestions.length})` });
      all.addEventListener("click", () => void this.plugin.reviewLinkSuggestions(file));
    }
  }

  /** Turn one mention into a wikilink in place (atomic; drift-safe). */
  private async applyMention(file: TFile, m: Mention): Promise<void> {
    try {
      await this.app.vault.process(file, (current) => linkMention(current, m));
    } catch {
      /* note changed — the debounced re-render will refresh the list */
    }
    await this.render();
  }

  /** Insert a [[wikilink]] to the related note at the cursor of the active editor. */
  private insertLink(activeFile: TFile, targetName: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const link = `[[${targetName}]]`;
    if (view && view.file?.path === activeFile.path) {
      view.editor.replaceSelection(link);
    } else {
      void this.app.vault.append(activeFile, `\n${link}\n`);
    }
  }
}
