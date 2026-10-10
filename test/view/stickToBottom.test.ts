import { describe, expect, it } from "vitest";
import { StickToBottom } from "../../src/view/chat/stickToBottom";

/** A scroller whose scrollTop clamps like a browser's. */
class Scroller {
  scrollHeight = 2000;
  clientHeight = 600;
  private top = 0;
  private readonly listeners = new Map<string, Array<() => void>>();
  get scrollTop(): number { return this.top; }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: () => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener)); }
  fire(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
  get bottomGap(): number { return this.scrollHeight - this.top - this.clientHeight; }
  /** A reader drag or browser clamp: move, then the scroll event. */
  scrollTo(top: number): void { this.scrollTop = top; this.fire("scroll"); }
}

function harness() {
  const el = new Scroller();
  const callbacks: { resize: Array<() => void>; content: Array<() => void> } = { resize: [], content: [] };
  const disconnected: string[] = [];
  const observer = (kind: "resize" | "content") => class {
    constructor(callback: () => void) { callbacks[kind].push(callback); }
    observe(): void {}
    disconnect(): void { disconnected.push(kind); }
  };
  const stick = new StickToBottom(el as unknown as HTMLElement, { ResizeObserver: observer("resize"), MutationObserver: observer("content") });
  const resized = (): void => { for (const callback of callbacks.resize) callback(); };
  const changed = (): void => { for (const callback of callbacks.content) callback(); };
  return { el, stick, resized, changed, disconnected };
}

describe("StickToBottom", () => {
  it("keeps the last message in view when the keyboard shrinks the transcript", () => {
    const { el, stick, resized } = harness();
    stick.jump();
    el.clientHeight = 300;
    resized();
    expect(el.bottomGap).toBe(0);
  });

  it("follows content that grows after it was added, such as rendered markdown", () => {
    const { el, stick, changed } = harness();
    stick.jump();
    el.scrollHeight = 2600;
    changed();
    expect(el.bottomGap).toBe(0);
  });

  it("stops following once the reader scrolls up, and resumes at the bottom", () => {
    const { el, stick, changed } = harness();
    stick.jump();
    el.scrollTo(400);
    expect(stick.following).toBe(false);
    el.scrollHeight = 2600;
    changed();
    expect(el.scrollTop).toBe(400);
    el.scrollTo(2600 - 600 - 20);
    expect(stick.following).toBe(true);
    changed();
    expect(el.bottomGap).toBe(0);
  });

  it("keeps following when a growing viewport clamps the scroll position", () => {
    const { el, stick } = harness();
    stick.jump();
    el.clientHeight = 900;
    el.scrollTo(el.scrollTop);
    expect(stick.following).toBe(true);
  });

  it("never moves the transcript under a touch, and catches up when it ends", () => {
    const { el, stick, changed } = harness();
    stick.jump();
    el.fire("touchstart");
    el.scrollHeight = 2600;
    changed();
    expect(el.bottomGap).toBe(600);
    el.fire("touchend");
    expect(el.bottomGap).toBe(0);
  });

  it("jumps back to the latest message when asked, even after scrolling up", () => {
    const { el, stick } = harness();
    stick.jump();
    el.scrollTo(100);
    stick.jump();
    expect(stick.following).toBe(true);
    expect(el.bottomGap).toBe(0);
  });

  it("follows an image or frame that changes height when it loads", () => {
    const { el, stick } = harness();
    stick.jump();
    el.scrollHeight = 2400;
    el.fire("load");
    expect(el.bottomGap).toBe(0);
  });

  it("releases its observers and listeners", () => {
    const { el, stick, disconnected } = harness();
    stick.jump();
    stick.destroy();
    expect(disconnected.sort()).toEqual(["content", "resize"]);
    el.scrollHeight = 2600;
    el.fire("load");
    expect(el.bottomGap).toBe(600);
  });
});
