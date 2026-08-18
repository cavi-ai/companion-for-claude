import { ItemView, WorkspaceLeaf, TFile, MarkdownView, setIcon, debounce } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { findUnlinkedMentions, linkMention, type Mention } from "../links/unlinkedMentions";
import { buildSuggestions } from "../links/suggest";
import { neighborhood } from "../links/neighborhood";
import { renderCompanionChrome } from "./companionChrome";

export const RELATED_VIEW_TYPE = "claude-related-view";

/**
 * Sidebar panel of notes semantically related to the active note (from the local
 * embeddings index). Updates as you navigate. Each row opens the note or inserts
 * a wikilink into the current note.
 */
export class RelatedView extends ItemView {
  private disposeChrome: ((remove?: boolean) => void) | null = null;
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

  override async onClose(): Promise<void> {
    this.disposeChrome?.(false);
    this.disposeChrome = null;
  }

  /** Re-render only when the active markdown file actually changed. */
  private async maybeRender(): Promise<void> {
    const path = this.app.workspace.getActiveFile()?.path ?? null;
    if (path !== this.shownPath) await this.render();
  }

  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const root = this.contentEl;
    this.disposeChrome?.();
    this.disposeChrome = null;
    root.empty();
    root.addClass("cc-related-view");
    this.disposeChrome = renderCompanionChrome(root, "related", "Related Notes", this.plugin.companionChrome());

    const file = this.app.workspace.getActiveFile();
    this.shownPath = file?.path ?? null;
    if (!(file instanceof TFile) || file.extension !== "md") {
      const empty = root.createEl("section", {
        cls: "cc-view-empty",
        attr: { role: "status", "aria-label": "Related Notes empty state" },
      });
      empty.createDiv({ cls: "cc-eyebrow", text: "RELATED NOTES" });
      empty.createEl("h3", { text: "Open a note to explore connections" });
      empty.createEl("p", { text: "Related Notes will map links, mentions, and semantic neighbors for the note you are reading." });
      return;
    }

    // ---- Neighborhood: outgoing links, backlinks, typed relations ----
    this.renderNeighborhood(root, file);

    // ---- Link suggestions (pure text — no embeddings needed) ----
    await this.renderSuggestions(root, file, seq);
    if (seq !== this.renderSeq) return;

    root.createDiv({ cls: "cc-eyebrow", text: "RELATED NOTES" });
    if (!this.plugin.settings.semanticEnabled) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "Turn on “Semantic search” in Companion settings to surface related notes.",
      });
      return;
    }

    root.createDiv({ cls: "cc-related-for", text: file.basename });
    const loading = root.createEl("p", { cls: "setting-item-description", text: "Finding related notes…" });

    let hits: { path: string; score: number }[];
    try {
      hits = await this.plugin.relatedNotes(file.path, 8);
    } catch (error) {
      if (seq === this.renderSeq) {
        loading.remove();
        const recovery = this.plugin.embeddingRecovery(error);
        const activityId = this.plugin.activity.start({
          id: `semantic-related:${file.path}`,
          kind: "semantic-index",
          title: "Related Notes unavailable",
        });
        this.plugin.activity.fail(activityId, {
          failed: 1,
          technicalDetails: recovery.technicalDetails,
          recovery: recovery.actions,
          details: [{ label: file.path, message: recovery.message, state: "error" }],
        });
        const card = root.createEl("section", {
          cls: "cc-embedding-recovery",
          attr: { role: "alert", "aria-label": "Embedding recovery" },
        });
        card.createEl("h3", { text: "Related Notes needs attention" });
        card.createEl("p", { cls: "cc-embedding-recovery-message", text: recovery.message });
        const actions = card.createDiv({ cls: "cc-embedding-recovery-actions" });
        for (const action of recovery.actions.filter(({ kind }) => kind !== "copy-details")) {
          const button = actions.createEl("button", { text: action.label });
          button.addEventListener("click", () => void this.plugin.runActivityRecovery(activityId, action.id));
        }
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

  /**
   * The "Connections" section: the active note's one-hop graph neighborhood
   * (backlinks, outgoing links, typed ontology relations) as grouped lists.
   */
  private renderNeighborhood(root: HTMLElement, file: TFile): void {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const registry = this.plugin.ontology();
    const typeName = fm?.type;
    const type = registry && typeof typeName === "string" ? registry.resolve(typeName) : undefined;
    const n = neighborhood(this.app.metadataCache.resolvedLinks, file.path, fm, type);
    if (n.incoming.length === 0 && n.outgoing.length === 0 && n.relations.length === 0) return;

    root.createDiv({ cls: "cc-eyebrow", text: "CONNECTIONS" });
    this.renderNeighborhoodGroup(root, "Backlinks", n.incoming);
    this.renderNeighborhoodGroup(root, "Links out", n.outgoing);

    const byKey = new Map<string, string[]>();
    for (const r of n.relations) {
      const list = byKey.get(r.key) ?? [];
      list.push(r.to);
      byKey.set(r.key, list);
    }
    for (const [key, targets] of byKey) {
      const def = type?.relations.find((r) => r.key === key);
      this.renderNeighborhoodGroup(
        root,
        def?.description ?? key.replace(/_/g, " "),
        targets.map((t) => this.app.metadataCache.getFirstLinkpathDest(t, file.path)?.path ?? t),
      );
    }
  }

  private renderNeighborhoodGroup(root: HTMLElement, title: string, paths: string[]): void {
    if (paths.length === 0) return;
    const group = root.createDiv({ cls: "cc-neighborhood-group" });
    group.createDiv({ cls: "cc-neighborhood-title", text: title });
    const list = group.createDiv({ cls: "cc-related-list" });
    for (const path of paths) {
      const target = this.app.vault.getAbstractFileByPath(path);
      const name = target instanceof TFile ? target.basename : path.replace(/\.md$/, "");
      const row = list.createDiv({ cls: "cc-related-row" });
      const open = row.createEl("button", { cls: "cc-related-open", text: name });
      if (target instanceof TFile) {
        open.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(target));
      } else {
        open.addClass("cc-neighborhood-unresolved");
        open.setAttr("title", `${path} — not resolved to a note`);
      }
    }
  }

  /** The "Link suggestions" section: unlinked mentions with one-click linking. */
  private async renderSuggestions(root: HTMLElement, file: TFile, seq: number): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    if (seq !== this.renderSeq) return;
    const mentions = findUnlinkedMentions(content, this.plugin.linkCandidates(), file.path);
    const suggestions = buildSuggestions(mentions, [], this.plugin.linkedTargets(file)).filter((s) => s.mention);
    if (suggestions.length === 0) return;

    root.createDiv({ cls: "cc-eyebrow", text: "LINK SUGGESTIONS" });
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
