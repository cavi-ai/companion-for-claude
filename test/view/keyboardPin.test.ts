import { describe, expect, it, vi } from "vitest";
import { pinChatAboveKeyboard } from "../../src/view/chat/keyboardPin";

type Listener = (event: { target?: unknown }) => void;

class Listeners {
  private readonly byType = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void { this.byType.set(type, [...(this.byType.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: Listener): void { this.byType.set(type, (this.byType.get(type) ?? []).filter((l) => l !== listener)); }
  fire(type: string, event: { target?: unknown } = {}): void { for (const listener of this.byType.get(type) ?? []) listener(event); }
}

class El extends Listeners {
  scrollTop = 0;
  constructor(readonly parentElement: El | null, readonly overflowY: string, readonly ownerDocument: { activeElement: unknown }) { super(); }
  contains(node: unknown): boolean {
    for (let n = node as El | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
}

function harness() {
  const doc: { activeElement: unknown } = { activeElement: null };
  const html = new El(null, "visible", doc);
  const app = new El(html, "hidden", doc);
  const root = new El(app, "hidden", doc);
  const messages = new El(root, "auto", doc);
  const messageButton = new El(messages, "visible", doc);
  const composer = new El(root, "visible", doc);
  const textarea = new El(composer, "auto", doc);
  const note = new El(app, "hidden", doc);
  const viewport = Object.assign(new Listeners(), { offsetTop: 0 });
  const win = Object.assign(new Listeners(), {
    scrollY: 0,
    visualViewport: viewport,
    scrollTo: vi.fn((_x: number, y: number) => { win.scrollY = y; viewport.offsetTop = 0; }),
    getComputedStyle: (el: El) => ({ overflowY: el.overflowY }),
  });
  const stop = pinChatAboveKeyboard(root as unknown as HTMLElement, win as unknown as Window);
  const focus = (el: El): void => { doc.activeElement = el; };
  return { doc, html, app, root, messages, messageButton, composer, textarea, note, viewport, win, stop, focus };
}

describe("pinChatAboveKeyboard", () => {
  it("undoes the page and ancestor scroll the keyboard reveal adds while the composer has focus", () => {
    const h = harness();
    h.focus(h.textarea);
    h.messages.scrollTop = 500;
    h.textarea.scrollTop = 20;
    h.win.scrollY = 413;
    h.html.scrollTop = 413;
    h.app.scrollTop = 120;
    h.composer.scrollTop = 8;
    h.viewport.fire("resize");
    expect(h.win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect([h.html.scrollTop, h.app.scrollTop, h.root.scrollTop, h.composer.scrollTop]).toEqual([0, 0, 0, 0]);
    expect(h.messages.scrollTop).toBe(500);
    expect(h.textarea.scrollTop).toBe(20);
  });

  it("undoes a visual viewport pan with no page scroll", () => {
    const h = harness();
    h.focus(h.textarea);
    h.viewport.offsetTop = 413;
    h.viewport.fire("scroll");
    expect(h.win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("undoes a reveal that scrolls a clipped ancestor without moving the page", () => {
    const h = harness();
    h.focus(h.textarea);
    h.root.scrollTop = 300;
    h.win.fire("scroll", { target: h.root });
    expect(h.root.scrollTop).toBe(0);
    expect(h.win.scrollTo).not.toHaveBeenCalled();
  });

  it("leaves transcript scrolling and focus outside the chat alone", () => {
    const h = harness();
    h.focus(h.textarea);
    h.app.scrollTop = 50;
    h.win.fire("scroll", { target: h.messages });
    expect(h.app.scrollTop).toBe(50);
    h.focus(h.note);
    h.win.scrollY = 413;
    h.viewport.fire("resize");
    h.win.fire("scroll", { target: h.doc });
    expect(h.win.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the transcript position when focus sits inside it", () => {
    const h = harness();
    h.focus(h.messageButton);
    h.messages.scrollTop = 500;
    h.root.scrollTop = 40;
    h.viewport.fire("resize");
    expect(h.messages.scrollTop).toBe(500);
    expect(h.root.scrollTop).toBe(0);
  });

  it("settles once more as the chat input loses focus", () => {
    const h = harness();
    h.focus(h.note);
    h.app.scrollTop = 120;
    h.root.fire("focusout", { target: h.textarea });
    expect(h.app.scrollTop).toBe(0);
  });

  it("stops reacting once stopped", () => {
    const h = harness();
    h.focus(h.textarea);
    h.stop();
    h.win.scrollY = 413;
    h.root.scrollTop = 300;
    h.viewport.fire("resize");
    h.viewport.fire("scroll");
    h.win.fire("scroll", { target: h.root });
    h.root.fire("focusout", { target: h.textarea });
    expect(h.win.scrollTo).not.toHaveBeenCalled();
    expect(h.root.scrollTop).toBe(300);
  });
});
