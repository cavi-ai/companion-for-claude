type Bounds = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;

/** Only panes intersecting the host status bar need space below their controls. */
export function statusBarBottomInset(pane: Bounds, bar: Bounds): number {
  if (pane.right <= pane.left || pane.bottom <= pane.top || bar.right <= bar.left || bar.bottom <= bar.top
    || bar.right <= pane.left || bar.left >= pane.right || bar.bottom <= pane.top || bar.top >= pane.bottom) return 0;
  return pane.bottom - Math.max(pane.top, bar.top);
}

type SubscribeLayout = (listener: () => void) => () => void;
const INSET = "--cc-host-bottom-inset";

/** Keep chat controls above native host chrome without changing the host itself. */
export function reserveHostStatusBar(root: HTMLElement, subscribeLayout: SubscribeLayout): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => {};
  let disposed = false;
  let frame: number | null = null;
  let statusBar: HTMLElement | null = null;

  const queue = (): void => {
    if (disposed || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; refresh(); });
  };
  const resize = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(queue) : null;
  const statusChanges = typeof view.MutationObserver === "function" ? new view.MutationObserver(queue) : null;
  const hostChanges = typeof view.MutationObserver === "function" ? new view.MutationObserver(queue) : null;

  const refresh = (): void => {
    if (disposed) return;
    const current = doc.querySelector<HTMLElement>(".status-bar");
    if (current !== statusBar) {
      if (statusBar) resize?.unobserve(statusBar);
      statusChanges?.disconnect();
      statusBar = current;
      if (statusBar) {
        resize?.observe(statusBar);
        statusChanges?.observe(statusBar, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
      }
    }
    let inset = 0;
    if (statusBar) {
      const style = view.getComputedStyle(statusBar);
      if (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse") {
        inset = statusBarBottomInset(root.getBoundingClientRect(), statusBar.getBoundingClientRect());
      }
    }
    const value = `${inset}px`;
    if (root.style.getPropertyValue(INSET) !== value) root.style.setProperty(INSET, value);
  };

  resize?.observe(root);
  if (doc.body) hostChanges?.observe(doc.body, { attributes: true, attributeFilter: ["class", "style"] });
  view.addEventListener("resize", queue);
  const unsubscribeLayout = subscribeLayout(queue);
  refresh();
  queue();

  return () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    resize?.disconnect();
    statusChanges?.disconnect();
    hostChanges?.disconnect();
    view.removeEventListener("resize", queue);
    unsubscribeLayout();
    root.style.removeProperty(INSET);
  };
}
