import { type SlashCommand, filterCommands, moveSelection } from "./slashCommands";

/**
 * A floating command palette rendered above the composer. Owns its own DOM and
 * keyboard-driven selection; the ChatView drives it (open/filter/close) and
 * receives the chosen command via the onChoose callback.
 */
export class SlashMenu {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private matches: SlashCommand[] = [];
  private selected = 0;
  private open = false;

  constructor(
    private parent: HTMLElement,
    private commands: SlashCommand[],
    private onChoose: (cmd: SlashCommand) => void,
  ) {
    this.el = parent.createDiv({ cls: "cc-slash-menu" });
    this.el.setCssStyles({ display: "none" });
    this.listEl = this.el.createDiv({ cls: "cc-slash-list" });
  }

  isOpen(): boolean {
    return this.open;
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
    this.el.setCssStyles({ display: "none" });
    this.listEl.empty();
  }

  /** Arrow navigation. Returns true if handled. */
  move(delta: number): void {
    this.selected = moveSelection(this.selected, delta, this.matches.length);
    this.render();
  }

  /** Commit the current selection. */
  choose(): void {
    const cmd = this.matches[this.selected];
    if (cmd) {
      this.hide();
      this.onChoose(cmd);
    }
  }

  private render(): void {
    this.listEl.empty();
    this.matches.forEach((cmd, i) => {
      const row = this.listEl.createDiv({ cls: "cc-slash-item" });
      row.toggleClass("is-selected", i === this.selected);
      row.createSpan({ cls: "cc-slash-name", text: `/${cmd.name}` });
      row.createSpan({ cls: "cc-slash-desc", text: cmd.description });
      row.addEventListener("mouseenter", () => {
        this.selected = i;
        this.render();
      });
      row.addEventListener("mousedown", (e) => {
        // mousedown (not click) so we beat the textarea's blur.
        e.preventDefault();
        this.selected = i;
        this.choose();
      });
    });
  }

  destroy(): void {
    this.el.remove();
  }
}
