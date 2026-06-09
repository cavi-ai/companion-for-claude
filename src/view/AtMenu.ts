import { setIcon } from "obsidian";
import { type AtItem, type AtKind, filterAtItems } from "../context/atMention";

const ICON: Record<AtKind, string> = {
  note: "file-text",
  selection: "text-cursor",
  linked: "link",
  vault: "search",
  "note-path": "file",
  "folder-path": "folder",
};

/**
 * Floating "@" context picker above the composer. Mirrors SlashMenu: ChatView
 * drives it (show/filter/close) and gets the chosen source via onChoose. The
 * candidate list is supplied lazily so it reflects the current vault.
 */
export class AtMenu {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private matches: AtItem[] = [];
  private selected = 0;
  private open = false;

  constructor(
    parent: HTMLElement,
    private items: () => AtItem[],
    private onChoose: (item: AtItem) => void,
  ) {
    this.el = parent.createDiv({ cls: "cc-slash-menu cc-at-menu" });
    this.el.setCssStyles({ display: "none" });
    this.listEl = this.el.createDiv({ cls: "cc-slash-list" });
  }

  isOpen(): boolean {
    return this.open;
  }

  show(query: string): void {
    this.matches = filterAtItems(this.items(), query);
    if (this.matches.length === 0) {
      this.hide();
      return;
    }
    this.selected = 0;
    this.open = true;
    this.el.setCssStyles({ display: "" });
    this.render();
  }

  hide(): void {
    if (!this.open && this.el.style.display === "none") return;
    this.open = false;
    this.el.setCssStyles({ display: "none" });
    this.listEl.empty();
  }

  move(delta: number): void {
    if (this.matches.length === 0) return;
    this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
    this.render();
  }

  choose(): void {
    const item = this.matches[this.selected];
    if (item) {
      this.hide();
      this.onChoose(item);
    }
  }

  private render(): void {
    this.listEl.empty();
    this.matches.forEach((item, i) => {
      const row = this.listEl.createDiv({ cls: "cc-slash-item cc-at-item" });
      row.toggleClass("is-selected", i === this.selected);
      setIcon(row.createSpan({ cls: "cc-at-icon" }), ICON[item.kind]);
      row.createSpan({ cls: "cc-slash-name", text: item.label });
      if (item.sublabel) row.createSpan({ cls: "cc-slash-desc", text: item.sublabel });
      row.addEventListener("mouseenter", () => {
        this.selected = i;
        this.render();
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // beat the textarea blur
        this.selected = i;
        this.choose();
      });
    });
  }

  destroy(): void {
    this.el.remove();
  }
}
