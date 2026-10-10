// On a phone the app container shrinks to sit above the soft keyboard. WebKit's reveal of the focused
// input then scrolls the page, the visual viewport, or a clipped ancestor by the keyboard height as well,
// which lifts the composer to the top of the screen. While focus is inside the chat, those scrolls are
// undone so the composer stays above the keyboard. Elements users scroll (overflow auto or scroll) keep
// their position.

type PinWindow = Pick<Window, "scrollY" | "scrollTo" | "visualViewport" | "getComputedStyle" | "addEventListener" | "removeEventListener">;

/** Keep a focused input inside the chat root above the keyboard; returns the function that stops it. */
export function pinChatAboveKeyboard(root: HTMLElement, win: PinWindow): () => void {
  const doc = root.ownerDocument;
  const viewport = win.visualViewport;
  const userScrolls = (el: Element): boolean => /^(auto|scroll)$/.test(win.getComputedStyle(el).overflowY);

  const settle = (from: Element | null): void => {
    if (!from || !root.contains(from)) return;
    for (let el = from.parentElement; el; el = el.parentElement) {
      if (el.scrollTop !== 0 && !userScrolls(el)) el.scrollTop = 0;
    }
    if (win.scrollY !== 0 || (viewport?.offsetTop ?? 0) !== 0) win.scrollTo(0, 0);
  };
  const onViewport = (): void => settle(doc.activeElement);
  const onScroll = (event: Event): void => {
    const active = doc.activeElement;
    const target = event.target as Node | Document | null;
    if (target === doc || (target !== active && !!target && target.contains(active))) settle(active);
  };
  const onFocusOut = (event: FocusEvent): void => settle(event.target as Element | null);

  viewport?.addEventListener("scroll", onViewport);
  viewport?.addEventListener("resize", onViewport);
  win.addEventListener("scroll", onScroll, true);
  root.addEventListener("focusout", onFocusOut);
  return () => {
    viewport?.removeEventListener("scroll", onViewport);
    viewport?.removeEventListener("resize", onViewport);
    win.removeEventListener("scroll", onScroll, true);
    root.removeEventListener("focusout", onFocusOut);
  };
}
