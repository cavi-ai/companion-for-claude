import { type SlashCommand, filterCommands, moveSelection } from "./slashCommands";

/**
 * A floating command palette rendered above the composer. Owns its own DOM and
 * keyboard-driven selection; the ChatView drives it (open/filter/close) and
 * receives the chosen command via the onChoose callback.
 */
export class SlashMenu {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private selectedEl: HTMLElement;
  private matches: SlashCommand[] = [];
  private selected = 0;
  private open = false;
  private gesture: { id: number; x: number; y: number; scroll: number; moved: boolean } | undefined;

  constructor(
    parent: HTMLElement,
    private commands: SlashCommand[],
    private onChoose: (cmd: SlashCommand) => void,
  ) {
    this.el = parent.createDiv({ cls: "cc-slash-menu" });
    this.el.setCssStyles({ display: "none" });
    this.listEl = this.el.createDiv({ cls: "cc-slash-list" });
    const footer = this.el.createDiv({ cls: "cc-slash-footer" });
    this.selectedEl = footer.createSpan({ cls: "cc-slash-selected" });
    const run = footer.createEl("button", { cls: "cc-slash-run mod-cta", text: "Run", attr: { type: "button", "aria-label": "Run selected command" } });
    run.addEventListener("mousedown", (event) => event.preventDefault());
    run.addEventListener("click", () => this.choose());
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Swap the catalog (e.g. user templates reloaded) — closes any open listing. */
  setCommands(commands: SlashCommand[]): void {
    this.commands = commands;
    this.hide();
  }

  /** Show/refresh the menu for a query. Closes if nothing matches. */
  show(query: string): void {
    this.matches = filterCommands(this.commands, query);
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
    this.gesture = undefined;
    this.el.setCssStyles({ display: "none" });
    this.listEl.empty();
  }

  /** Arrow navigation. Returns true if handled. */
  move(delta: number): void {
    this.selected = moveSelection(this.selected, delta, this.matches.length);
    this.highlight();
    this.listEl.children[this.selected]?.scrollIntoView?.({ block: "nearest" });
  }

  /** Keeps the menu while focus is inside it or back in `input`. */
  hideUnlessFocused(input?: Element): void {
    const active = this.el.ownerDocument?.activeElement ?? null;
    if (active !== null && (active === input || this.el.contains(active))) return;
    this.hide();
  }

  private highlight(): void {
    Array.from(this.listEl.children).forEach((row, i) => {
      row.toggleClass("is-selected", i === this.selected);
      row.setAttr("aria-pressed", String(i === this.selected));
    });
    this.selectedEl.setText(`Selected: /${this.matches[this.selected]?.name ?? ""}`);
  }

  /** Commit the current selection. */
  choose(): void {
    if (!this.open) return;
    const cmd = this.matches[this.selected];
    if (cmd) {
      this.hide();
      this.onChoose(cmd);
    }
  }

  private render(): void {
    this.listEl.empty();
    this.matches.forEach((cmd, i) => {
      const row = this.listEl.createEl("button", { cls: "cc-slash-item", attr: { type: "button" } });
      row.toggleClass("is-selected", i === this.selected);
      // Full description as a native hover tooltip — the inline `.cc-slash-desc`
      // is single-line and ellipsis-truncated, so hovering reveals the rest.
      const aliasNote = cmd.aliases?.length ? ` (also: ${cmd.aliases.map((a) => `/${a}`).join(", ")})` : "";
      row.setAttr("title", `/${cmd.name} — ${cmd.description}${aliasNote}`);
      row.createSpan({ cls: "cc-slash-name", text: `/${cmd.name}` });
      row.createSpan({ cls: "cc-slash-desc", text: cmd.description });
      row.addEventListener("pointerdown", (e) => {
        this.gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, scroll: this.listEl.scrollTop, moved: false };
        // Preserve desktop input focus without blocking native touch scrolling.
        if (e.pointerType === "mouse") e.preventDefault();
      });
      const moved = (e: PointerEvent): void => {
        const gesture = this.gesture;
        if (gesture?.id === e.pointerId && (Math.abs(e.clientX - gesture.x) > 8 || Math.abs(e.clientY - gesture.y) > 8)) gesture.moved = true;
      };
      row.addEventListener("pointermove", moved);
      row.addEventListener("pointerup", moved);
      row.addEventListener("pointercancel", () => { if (this.gesture) this.gesture.moved = true; });
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => {
        const gesture = this.gesture;
        this.gesture = undefined;
        if (gesture && (gesture.moved || gesture.scroll !== this.listEl.scrollTop)) return;
        this.selected = i;
        this.highlight();
      });
    });
    this.highlight();
  }

  destroy(): void {
    this.el.remove();
  }
}
