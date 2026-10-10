// Keeps a chat transcript on its latest message, the way messaging apps do. While the reader is at the
// bottom, new or re-rendered content and a smaller viewport (the keyboard opening, the composer growing)
// keep the last message in view. Scrolling up to read stops following until the reader is back at the
// bottom; a touch in progress is never overridden.

/** Within this distance of the end the reader counts as at the bottom. */
const NEAR_BOTTOM_PX = 32;

interface Observer { observe(target: Element, options?: object): void; disconnect(): void }

export interface StickDeps {
  ResizeObserver?: new (callback: () => void) => Observer;
  MutationObserver?: new (callback: () => void) => Observer;
}

export class StickToBottom {
  private pinned = true;
  private touching = false;
  private lastTop = 0;
  private readonly observers: Observer[] = [];

  constructor(private readonly el: HTMLElement, deps: StickDeps) {
    el.addEventListener("scroll", this.onScroll, { passive: true });
    el.addEventListener("touchstart", this.onTouchStart, { passive: true });
    el.addEventListener("touchend", this.onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", this.onTouchEnd, { passive: true });
    // Images and artifact frames change height when they load; load does not bubble, so listen in capture.
    el.addEventListener("load", this.follow, true);
    if (deps.ResizeObserver) {
      const resize = new deps.ResizeObserver(this.follow);
      resize.observe(el);
      this.observers.push(resize);
    }
    if (deps.MutationObserver) {
      const content = new deps.MutationObserver(this.follow);
      content.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "open"] });
      this.observers.push(content);
    }
  }

  /** Whether the transcript is following its latest message. */
  get following(): boolean {
    return this.pinned;
  }

  /** Show the latest message now and keep following it (a sent message, an opened conversation). */
  jump(): void {
    this.pinned = true;
    this.toEnd();
  }

  /** Keep the latest message in view while following. */
  readonly follow = (): void => {
    if (this.pinned && !this.touching) this.toEnd();
  };

  destroy(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
    this.el.removeEventListener("scroll", this.onScroll);
    this.el.removeEventListener("touchstart", this.onTouchStart);
    this.el.removeEventListener("touchend", this.onTouchEnd);
    this.el.removeEventListener("touchcancel", this.onTouchEnd);
    this.el.removeEventListener("load", this.follow, true);
  }

  private toEnd(): void {
    this.el.scrollTop = this.el.scrollHeight;
    this.lastTop = this.el.scrollTop;
  }

  private readonly onScroll = (): void => {
    const top = this.el.scrollTop;
    if (this.el.scrollHeight - top - this.el.clientHeight <= NEAR_BOTTOM_PX) this.pinned = true;
    else if (top < this.lastTop) this.pinned = false;
    this.lastTop = top;
  };

  private readonly onTouchStart = (): void => {
    this.touching = true;
  };

  private readonly onTouchEnd = (): void => {
    this.touching = false;
    this.follow();
  };
}
