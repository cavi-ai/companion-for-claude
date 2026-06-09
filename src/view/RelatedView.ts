import { ItemView, WorkspaceLeaf, TFile, MarkdownView, setIcon } from "obsidian";
import type ClaudeCompanionPlugin from "../main";

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

  getViewType(): string {
    return RELATED_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Related notes";
  }
  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.maybeRender()));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.maybeRender()));
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
    root.createEl("div", { cls: "cc-eyebrow", text: "RELATED NOTES" });

    if (!this.plugin.settings.semanticEnabled) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "Turn on “Semantic search” in Companion settings to surface related notes.",
      });
      return;
    }

    const file = this.app.workspace.getActiveFile();
    this.shownPath = file?.path ?? null;
    if (!(file instanceof TFile) || file.extension !== "md") {
      root.createEl("p", { cls: "setting-item-description", text: "Open a note to see what it connects to." });
      return;
    }

    root.createEl("div", { cls: "cc-related-for", text: file.basename });
    const loading = root.createEl("p", { cls: "setting-item-description", text: "Finding related notes…" });

    let hits: { path: string; score: number }[];
    try {
      hits = await this.plugin.relatedNotes(file.path, 8);
    } catch {
      if (seq === this.renderSeq) loading.setText("Couldn’t compute related notes — is Ollama running?");
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
