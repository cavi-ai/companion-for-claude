import { ItemView, WorkspaceLeaf, TFile, normalizePath, setIcon } from "obsidian";
import type ClaudeCompanionPlugin from "../main";

export const MEMORY_VIEW_TYPE = "claude-memory-view";

/** Sidebar list of captured session digest notes, with open / re-ingest. */
export class MemoryView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: ClaudeCompanionPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return MEMORY_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return "Claude session memory";
  }
  override getIcon(): string {
    return "brain";
  }

  override async onOpen(): Promise<void> {
    // Obsidian parses a new note's frontmatter on a debounce *after* the write,
    // so an immediate refresh can miss the just-captured note. Re-render when the
    // metadata cache resolves, and when notes are deleted/renamed. registerEvent
    // ties these listeners to the view lifecycle (auto-removed on close).
    this.registerEvent(this.app.metadataCache.on("changed", () => void this.render()));
    this.registerEvent(this.app.vault.on("delete", () => void this.render()));
    this.registerEvent(this.app.vault.on("rename", () => void this.render()));
    await this.render();
  }

  /** Notes in the memory folder that carry a `session_id` frontmatter key. */
  private capturedNotes(): TFile[] {
    const dir = normalizePath(this.plugin.settings.memoryFolder);
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${dir}/`))
      .filter((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        return fm != null && ("session_id" in fm || "claude-session" in fm);
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cc-memory-view");
    root.createEl("div", { cls: "cc-eyebrow", text: "SESSION MEMORY" });

    const notes = this.capturedNotes();
    if (notes.length === 0) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "No captured sessions yet. Use “Capture session memory…” to ingest a Claude Code session.",
      });
      return;
    }

    const list = root.createDiv({ cls: "cc-memory-list" });
    for (const f of notes) {
      const row = list.createDiv({ cls: "cc-memory-row" });
      const open = row.createEl("button", { cls: "cc-memory-open", text: f.basename });
      open.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(f));

      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const sessionId = String(fm?.["session_id"] ?? fm?.["claude-session"] ?? "");
      const reBtn = row.createEl("button", { cls: "cc-action", attr: { "aria-label": "Re-ingest", title: "Re-ingest" } });
      setIcon(reBtn, "refresh-cw");
      reBtn.addEventListener("click", () => void this.plugin.reingestSession(sessionId));
    }
  }
}
