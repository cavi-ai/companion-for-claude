import { Menu, Modal, setIcon, type App } from "obsidian";
import { type Conversation, relativeTime } from "../../conversations/store";

type Action = (conversation: Conversation) => void | Promise<void>;

export interface SessionDropdownActions {
  resume: Action;
  rename: (conversation: Conversation, title: string) => void | Promise<void>;
  fork: Action;
  forkFromSummary: Action;
  distill: Action;
  archive: Action;
  unarchive: Action;
  remove: Action;
}

export interface SessionDropdownOptions {
  app: App;
  anchor: HTMLElement;
  conversations: () => Conversation[];
  activeId: () => string | null;
  actions: SessionDropdownActions;
  promptRename?: (current: string) => Promise<string | null>;
  onClose?: () => void;
}

const WIDTH = 360;
const GAP = 4;
const EDGE = 8;
const DELETE_ARM_MS = 2500;

class RenameModal extends Modal {
  private result: string | null = null;

  constructor(app: App, private current: string, private done: (title: string | null) => void) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Rename session");
    const input = this.contentEl.createEl("input", { cls: "cc-session-rename-input", attr: { type: "text", "aria-label": "Session title" } });
    input.value = this.current;
    input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key !== "Enter") return;
      evt.preventDefault();
      this.result = input.value;
      this.close();
    });
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  override onClose(): void {
    this.done(this.result);
  }
}

function promptRenameModal(app: App, current: string): Promise<string | null> {
  return new Promise((resolve) => new RenameModal(app, current, resolve).open());
}

function age(epochMs: number): string {
  return relativeTime(epochMs).replace(/ ago$/, "");
}

/** Anchored popover over saved conversations: search, resume, and a per-row actions menu. */
export class SessionDropdown {
  private root: HTMLElement | null = null;
  private listEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private query = "";
  private showArchived = false;
  private selected = 0;
  private suspended = false;
  private armed: { id: string; timer: number } | null = null;
  private visible: Conversation[] = [];

  private readonly onOutside = (evt: { target?: unknown }): void => {
    if (this.suspended || !this.root) return;
    const target = evt.target as HTMLElement | null;
    if (target && (this.root.contains(target) || this.options.anchor.contains(target) || target.closest?.(".menu"))) return;
    this.close();
  };

  constructor(private options: SessionDropdownOptions) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  open(): void {
    if (this.root) return;
    const root = activeDocument.body.createDiv({ cls: "cc-session-dropdown", attr: { role: "dialog", "aria-label": "Sessions" } });
    this.root = root;
    this.searchEl = root.createEl("input", {
      cls: "cc-session-search",
      attr: { type: "text", placeholder: "Search sessions…", "aria-label": "Search sessions" },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value;
      this.selected = 0;
      this.renderList();
    });
    this.listEl = root.createDiv({ cls: "cc-session-list", attr: { role: "listbox" } });
    this.footerEl = root.createDiv({ cls: "cc-session-footer" });
    root.addEventListener("keydown", (evt: KeyboardEvent) => this.onKey(evt));
    activeDocument.addEventListener("mousedown", this.onOutside, true);
    this.position();
    this.render();
    this.searchEl.focus();
  }

  close(returnFocus = false): void {
    const root = this.root;
    if (!root) return;
    this.root = null;
    if (this.armed) window.clearTimeout(this.armed.timer);
    this.armed = null;
    activeDocument.removeEventListener("mousedown", this.onOutside, true);
    root.remove();
    if (returnFocus) this.options.anchor.focus();
    this.options.onClose?.();
  }

  /** Re-render from the current conversation list. */
  refresh(): void {
    if (this.root) this.render();
  }

  private position(): void {
    if (!this.root) return;
    const rect = this.options.anchor.getBoundingClientRect();
    const width = Math.min(WIDTH, activeWindow.innerWidth - EDGE * 2);
    const left = Math.max(EDGE, Math.min(rect.right - width, activeWindow.innerWidth - width - EDGE));
    this.root.setCssProps({ top: `${rect.bottom + GAP}px`, left: `${left}px` });
  }

  private render(): void {
    this.renderList();
    this.renderFooter();
  }

  private archivedCount(): number {
    return this.options.conversations().filter((c) => c.archivedAt !== undefined).length;
  }

  private renderList(): void {
    this.listEl.empty();
    const needle = this.query.trim().toLowerCase();
    const activeId = this.options.activeId();
    this.visible = this.options.conversations().filter((c) =>
      (this.showArchived || c.archivedAt === undefined) && (needle === "" || c.title.toLowerCase().includes(needle)));
    if (this.visible.length === 0) {
      this.listEl.createDiv({ cls: "cc-session-empty", text: "No matching sessions" });
      return;
    }
    this.selected = Math.min(this.selected, this.visible.length - 1);
    this.visible.forEach((c, index) => {
      const archived = c.archivedAt !== undefined;
      const row = this.listEl.createDiv({ cls: "cc-session-row", attr: { role: "option" } });
      if (index === this.selected) row.addClass("is-selected");
      if (c.id === activeId) row.addClass("is-active");
      if (archived) row.addClass("is-archived");
      if (this.armed?.id === c.id) row.addClass("is-armed");
      if (archived) setIcon(row.createSpan({ cls: "cc-session-archived-icon" }), "archive");
      row.createSpan({ cls: "cc-session-title", text: c.title });
      const turns = c.messages.filter((m) => m.role === "user").length;
      row.createSpan({ cls: "cc-session-meta", text: `${age(c.updatedAt)} · ${turns} msg${turns === 1 ? "" : "s"}` });
      const more = row.createEl("button", { cls: "cc-session-more clickable-icon", attr: { "aria-label": `Session actions for ${c.title}` } });
      setIcon(more, "more-horizontal");
      more.addEventListener("click", (evt: MouseEvent) => {
        evt.stopPropagation();
        this.openMenu(c, more);
      });
      row.addEventListener("click", () => this.resume(c));
    });
  }

  private renderFooter(): void {
    this.footerEl.empty();
    const archived = this.archivedCount();
    if (archived === 0) return;
    const toggle = this.footerEl.createEl("button", {
      cls: "cc-session-archive-toggle",
      text: `${this.showArchived ? "Hide" : "Show"} archived (${archived})`,
    });
    toggle.addEventListener("click", () => {
      this.showArchived = !this.showArchived;
      this.selected = 0;
      this.render();
    });
  }

  private onKey(evt: KeyboardEvent): void {
    if (evt.key === "Escape") {
      evt.preventDefault();
      this.close(true);
    } else if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
      evt.preventDefault();
      if (this.visible.length === 0) return;
      const step = evt.key === "ArrowDown" ? 1 : -1;
      this.selected = (this.selected + step + this.visible.length) % this.visible.length;
      this.renderList();
      this.listEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
    } else if (evt.key === "Enter") {
      if ((evt.target as HTMLElement | null)?.tagName === "BUTTON") return;
      evt.preventDefault();
      const chosen = this.visible[this.selected];
      if (chosen) this.resume(chosen);
    }
  }

  private resume(conversation: Conversation): void {
    this.close();
    void this.options.actions.resume(conversation);
  }

  private openMenu(conversation: Conversation, anchor: HTMLElement): void {
    const { actions } = this.options;
    const armed = this.armed?.id === conversation.id;
    const menu = new Menu();
    const item = (title: string, icon: string, run: () => void, warning = false): void => {
      menu.addItem((i) => i.setTitle(title).setIcon(icon).setWarning(warning).onClick(run));
    };
    item("Rename", "pencil", () => void this.rename(conversation));
    item("Fork", "git-fork", () => this.closeThen(() => actions.fork(conversation)));
    item("Fork from summary", "git-branch", () => this.closeThen(() => actions.forkFromSummary(conversation)));
    item(conversation.distilledNote ? "Re-distill" : "Distill", "sparkles", () => void this.keepOpen(() => actions.distill(conversation)));
    if (conversation.archivedAt !== undefined) item("Unarchive", "archive-restore", () => void this.keepOpen(() => actions.unarchive(conversation)));
    else item("Archive", "archive", () => void this.keepOpen(() => actions.archive(conversation)));
    menu.addSeparator();
    item(armed ? "Confirm delete" : "Delete", "trash-2", () => this.deleteTapped(conversation, anchor), true);
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private deleteTapped(conversation: Conversation, anchor: HTMLElement): void {
    if (this.armed?.id !== conversation.id) {
      if (this.armed) window.clearTimeout(this.armed.timer);
      const timer = window.setTimeout(() => {
        this.armed = null;
        this.refresh();
      }, DELETE_ARM_MS);
      this.armed = { id: conversation.id, timer };
      this.refresh();
      window.setTimeout(() => { if (this.root) this.openMenu(conversation, anchor); }, 0);
      return;
    }
    window.clearTimeout(this.armed.timer);
    this.armed = null;
    if (conversation.id === this.options.activeId()) {
      this.closeThen(() => this.options.actions.remove(conversation));
      return;
    }
    void this.keepOpen(() => this.options.actions.remove(conversation));
  }

  private closeThen(run: () => void | Promise<void>): void {
    this.close();
    void run();
  }

  private async keepOpen(run: () => void | Promise<void>): Promise<void> {
    await run();
    this.refresh();
  }

  private async rename(conversation: Conversation): Promise<void> {
    this.suspended = true;
    let title: string | null;
    try {
      title = await (this.options.promptRename ?? ((current) => promptRenameModal(this.options.app, current)))(conversation.title);
    } finally {
      this.suspended = false;
    }
    const trimmed = title?.trim() ?? "";
    if (trimmed.length === 0 || trimmed === conversation.title) return;
    await this.keepOpen(() => this.options.actions.rename(conversation, trimmed));
  }
}
