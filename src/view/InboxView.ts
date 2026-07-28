import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { inboxItems, type InboxFileEntry, type InboxItem } from "../sources/inbox";
import { wireUpItems, type WireUpEntry } from "../links/wireUp";

export const INBOX_VIEW_TYPE = "claude-inbox-view";

/**
 * Source-inbox triage: everything the clipper dropped that isn't typed yet,
 * with one-tap enrich — plus a "wire up" section for enriched notes that
 * still mention other notes unlinked, so ingestion ends wired into the graph.
 * Built touch-first — on a phone this is the home base.
 */
export class InboxView extends ItemView {
  private enriching = new Set<string>();
  /** Bumped on every render so stale async wire-up scans can't paint. */
  private renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: ClaudeCompanionPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return INBOX_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return "Source inbox";
  }
  override getIcon(): string {
    return "inbox";
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => void this.render()));
    this.registerEvent(this.app.vault.on("delete", () => void this.render()));
    this.registerEvent(this.app.vault.on("rename", () => void this.render()));
    this.registerEvent(this.app.metadataCache.on("changed", () => void this.render()));
    await this.render();
  }

  private pending(): InboxItem[] {
    const entries: InboxFileEntry[] = this.app.vault.getFiles().map((f: TFile) => ({
      path: f.path,
      basename: f.basename,
      ext: f.extension,
      frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter ?? undefined,
    }));
    return inboxItems(entries, this.plugin.settings.sourceInboxFolder);
  }

  async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-inbox-view");
    root.createEl("div", { cls: "cc-eyebrow", text: "SOURCE INBOX" });

    if (!this.plugin.settings.sourceCaptureEnabled) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "Source capture is off. Turn it on in Companion settings → Source capture.",
      });
      return;
    }

    const items = this.pending();
    if (items.length === 0) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: `Inbox zero — nothing in “${this.plugin.settings.sourceInboxFolder}” needs typing. Clip something and it'll show up here.`,
      });
    } else {
      const bar = root.createDiv({ cls: "cc-inbox-bar" });
      bar.createSpan({ cls: "cc-inbox-count", text: `${items.length} to type` });
      const all = bar.createEl("button", { cls: "cc-inbox-enrich-all", text: "Enrich all" });
      all.addEventListener("click", () => void this.enrichAll(items));

      const list = root.createDiv({ cls: "cc-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "cc-inbox-row" });
        const open = row.createEl("button", { cls: "cc-inbox-open" });
        open.createSpan({ cls: "cc-inbox-name", text: item.basename });
        open.createSpan({ cls: `cc-inbox-type cc-inbox-type-${item.type}`, text: item.type });
        open.addEventListener("click", () => {
          const f = this.app.vault.getAbstractFileByPath(item.path);
          if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
        });

        const btn = row.createEl("button", {
          cls: "cc-inbox-enrich",
          attr: { "aria-label": `Enrich ${item.basename}` },
        });
        setIcon(btn, this.enriching.has(item.path) ? "loader" : "wand-sparkles");
        if (this.enriching.has(item.path)) btn.disabled = true;
        btn.addEventListener("click", () => void this.enrichOne(item));
      }
    }

    // Wire-up section: enriched notes that mention other notes without linking
    // them. Async (mention scan reads bodies) — guarded against stale renders.
    void this.renderWireUp(root, seq);
  }

  private async renderWireUp(root: HTMLElement, seq: number): Promise<void> {
    const inbox = this.plugin.settings.sourceInboxFolder.replace(/\/+$/, "");
    if (!inbox) return;
    const entries: WireUpEntry[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === inbox || !f.path.startsWith(`${inbox}/`)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.source_enriched !== true) continue;
      entries.push({
        path: f.path,
        basename: f.basename,
        ext: f.extension,
        frontmatter: fm,
        content: await this.app.vault.cachedRead(f),
      });
    }
    if (entries.length === 0) return;
    const items = wireUpItems(entries, this.plugin.linkCandidates(), inbox);
    if (items.length === 0 || seq !== this.renderSeq) return;

    const section = root.createDiv({ cls: "cc-inbox-wireup" });
    section.createEl("div", { cls: "cc-eyebrow", text: "WIRE INTO THE GRAPH" });
    const list = section.createDiv({ cls: "cc-inbox-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "cc-inbox-row" });
      const open = row.createEl("button", { cls: "cc-inbox-open" });
      open.createSpan({ cls: "cc-inbox-name", text: item.basename });
      open.createSpan({ cls: "cc-inbox-mentions", text: `${item.mentionCount} mention${item.mentionCount === 1 ? "" : "s"}` });
      open.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(item.path);
        if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
      });

      const btn = row.createEl("button", {
        cls: "cc-inbox-enrich",
        attr: { "aria-label": `Review link suggestions for ${item.basename}` },
      });
      setIcon(btn, "link");
      btn.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(item.path);
        if (f instanceof TFile) void this.plugin.reviewLinkSuggestions(f).then(() => this.render());
      });
    }
  }

  private async enrichOne(item: InboxItem): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(item.path);
    if (!(f instanceof TFile)) return;
    this.enriching.add(item.path);
    await this.render();
    try {
      await this.plugin.enrichInboxItem(f);
    } finally {
      this.enriching.delete(item.path);
      await this.render();
    }
  }

  private async enrichAll(items: InboxItem[]): Promise<void> {
    for (const item of items) await this.enrichOne(item);
  }
}
