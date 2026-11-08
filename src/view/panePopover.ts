export type PanePopoverDismissal = "outside" | "escape" | "replace";

interface Bounds { left: number; right: number; top: number; bottom: number }
export interface PanePopoverGeometry {
  pane: Bounds;
  anchor: Bounds;
  headerBottom: number;
  feedbackBottom: number;
  composerTop: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Keep secondary surfaces in the space between the pane's chrome and composer. */
export function panePopoverBounds(input: PanePopoverGeometry): { left: number; top: number; width: number; maxHeight: number } {
  const leftEdge = Math.max(8, input.pane.left + 8);
  const rightEdge = Math.min(input.viewportWidth - 8, input.pane.right - 8);
  const width = Math.max(0, Math.min(360, rightEdge - leftEdge));
  const left = Math.max(leftEdge, Math.min(input.anchor.right - width, rightEdge - width));
  const preferredTop = Math.max(input.pane.top + 8, input.anchor.bottom + 4, input.headerBottom + 4, input.feedbackBottom + 4);
  const bottom = Math.min(input.pane.bottom - 8, input.composerTop - 8, input.viewportHeight - 8);
  // Retain the Close control if the viewport cannot fit the full surface.
  const top = Math.min(preferredTop, Math.max(input.pane.top + 8, bottom - 44));
  return { left, top, width, maxHeight: Math.max(0, bottom - top) };
}

export function companionPane(anchor: HTMLElement): HTMLElement {
  return anchor.closest<HTMLElement>(".cc-chat-root") ?? anchor.closest<HTMLElement>(".cc-root")
    ?? popoverDocument(anchor).body;
}

function popoverDocument(anchor: HTMLElement): Document {
  return typeof anchor.ownerDocument?.addEventListener === "function" || typeof activeDocument?.addEventListener !== "function" ? anchor.ownerDocument : activeDocument;
}

const openByPane = new WeakMap<HTMLElement, PanePopover>();

export interface PanePopoverOptions {
  anchor: HTMLElement;
  panel: HTMLElement;
  onDismiss(reason: PanePopoverDismissal): void;
  suspended?(): boolean;
  ignoreOutside?(target: HTMLElement): boolean;
}

/** One secondary surface per Companion pane, with no global focus capture. */
export class PanePopover {
  readonly owner: HTMLElement;
  private readonly doc: Document;
  private readonly win: Window & { ResizeObserver?: typeof ResizeObserver };
  private observer: ResizeObserver | null = null;
  private disposed = false;

  constructor(private readonly options: PanePopoverOptions) {
    this.doc = popoverDocument(options.anchor);
    this.win = this.doc.defaultView ?? activeWindow;
    this.owner = companionPane(options.anchor);
    openByPane.get(this.owner)?.dismiss("replace");
    openByPane.set(this.owner, this);
    options.panel.addClass("cc-pane-popover");
    this.owner.appendChild(options.panel);
    this.doc.addEventListener?.("mousedown", this.onOutside, true);
    this.doc.addEventListener?.("keydown", this.onKey, true);
    options.panel.addEventListener("keydown", this.onKey);
    this.win.addEventListener?.("resize", this.reposition);
    this.doc.addEventListener?.("scroll", this.reposition, true);
    const Observer = this.win.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    if (Observer) {
      const observer = new Observer(this.reposition);
      this.observer = observer;
      const observed = new Set([this.owner, options.anchor, this.header(), this.owner.querySelector<HTMLElement>(".cc-feedback-host"), this.composer()]);
      for (const element of observed) if (element) observer.observe(element);
    }
    this.reposition();
  }

  private header(): HTMLElement | null {
    return this.owner.querySelector<HTMLElement>(".cc-header") ?? this.owner.querySelector<HTMLElement>(".cc-companion-chrome");
  }

  private composer(): HTMLElement | null {
    return this.owner.querySelector<HTMLElement>(".cc-composer");
  }

  readonly reposition = (): void => {
    if (this.disposed) return;
    const { anchor, panel } = this.options;
    const viewportWidth = this.win.innerWidth || 1024;
    const viewportHeight = this.win.innerHeight || 768;
    const pane = this.owner === this.doc.body ? { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight } : this.owner.getBoundingClientRect();
    const bounds = panePopoverBounds({
      pane, anchor: anchor.getBoundingClientRect(),
      headerBottom: this.header()?.getBoundingClientRect().bottom ?? 0,
      feedbackBottom: this.owner.querySelector<HTMLElement>(".cc-feedback-host")?.getBoundingClientRect().bottom ?? 0,
      composerTop: this.composer()?.getBoundingClientRect().top ?? pane.bottom,
      viewportWidth, viewportHeight,
    });
    const bodyOwned = this.owner === this.doc.body;
    const styles = {
      position: bodyOwned ? "fixed" : "absolute",
      left: `${bounds.left - (bodyOwned ? 0 : pane.left + (this.owner.clientLeft || 0) - (this.owner.scrollLeft || 0))}px`,
      top: `${bounds.top - (bodyOwned ? 0 : pane.top + (this.owner.clientTop || 0) - (this.owner.scrollTop || 0))}px`,
      width: `${bounds.width}px`, "min-width": `${bounds.width}px`, "max-width": `${bounds.width}px`, "max-height": `${bounds.maxHeight}px`,
    };
    panel.setCssProps(styles);
  };

  private readonly onOutside = (event: MouseEvent): void => {
    if (this.disposed || this.options.suspended?.()) return;
    const target = event.target as HTMLElement | null;
    if (target && (this.options.panel.contains(target) || this.options.anchor.contains(target) || this.options.ignoreOutside?.(target))) return;
    this.dismiss("outside");
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (this.disposed || this.options.suspended?.() || event.key !== "Escape") return;
    // An open menu/modal owns its own Escape before the underlying surface.
    const target = event.target as HTMLElement | null;
    if (target && (!this.owner.contains(target) || this.options.ignoreOutside?.(target))) return;
    event.preventDefault();
    event.stopPropagation?.();
    this.dismiss("escape");
  };

  private dismiss(reason: PanePopoverDismissal): void {
    if (this.disposed) return;
    this.dispose();
    this.options.onDismiss(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener?.("mousedown", this.onOutside, true);
    this.doc.removeEventListener?.("keydown", this.onKey, true);
    this.options.panel.removeEventListener("keydown", this.onKey);
    this.win.removeEventListener?.("resize", this.reposition);
    this.doc.removeEventListener?.("scroll", this.reposition, true);
    if (openByPane.get(this.owner) === this) openByPane.delete(this.owner);
  }
}
