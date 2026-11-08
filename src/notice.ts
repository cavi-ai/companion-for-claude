import { Notice } from "obsidian";

/** Brief confirmation for an action whose result is already visible in the UI. */
export const QUICK_NOTICE_MS = 1_800;

interface FeedbackHost { root: HTMLElement; host: HTMLElement }
const hosts = new Set<FeedbackHost>();
const fallbacks = new WeakMap<Document, HTMLElement>();
let preferred: FeedbackHost | undefined;

function visible(entry: FeedbackHost, doc: Document): boolean {
  return entry.root.ownerDocument === doc && entry.root.isConnected !== false
    && (typeof entry.root.checkVisibility !== "function" || entry.root.checkVisibility());
}

function destination(doc: Document): HTMLElement {
  if (preferred && hosts.has(preferred) && visible(preferred, doc)) return preferred.host;
  const entries = [...hosts].filter((entry) => visible(entry, doc));
  const focused = entries.find((entry) => entry.root.contains(doc.activeElement));
  if (focused) return focused.host;
  if (entries.length) return entries[entries.length - 1]!.host;
  let fallback = fallbacks.get(doc);
  if (!fallback || fallback.isConnected === false) {
    fallback = doc.body.createDiv({ cls: "cc-feedback-fallback", attr: { role: "status", "aria-live": "polite", "aria-atomic": "false", "aria-relevant": "additions text" } });
    fallbacks.set(doc, fallback);
  }
  return fallback;
}

/** Move only this plugin's native Notice node; its lifetime and hide API remain native. */
export class CompanionNotice extends Notice {
  private dismissButton?: HTMLButtonElement;
  private previousFocus: HTMLElement | null = null;
  private ownerPane: HTMLElement | null = null;

  constructor(message: string | DocumentFragment, timeout?: number) {
    const focusedBefore = activeDocument.activeElement;
    super(message, timeout);
    const element = this.surface;
    const focused = focusedBefore?.ownerDocument === element.ownerDocument ? focusedBefore : element.ownerDocument.activeElement;
    this.previousFocus = focused && typeof (focused as HTMLElement).focus === "function" ? focused as HTMLElement : null;
    element.addClass("cc-companion-notice");
    const host = destination(element.ownerDocument);
    host.appendChild(element);
    this.ownerPane = host.closest<HTMLElement>(".cc-chat-root") ?? host.closest<HTMLElement>(".cc-root");
    this.attachDismiss();
  }

  private get surface(): HTMLElement {
    return this.containerEl;
  }

  private attachDismiss(): void {
    if (!this.dismissButton) {
      this.dismissButton = this.surface.createEl("button", {
        cls: "cc-feedback-dismiss", text: "Dismiss", attr: { type: "button", "aria-label": "Dismiss feedback" },
      });
      this.dismissButton.addEventListener("click", (event) => { event.stopPropagation(); this.hide(); });
    } else {
      this.surface.appendChild(this.dismissButton);
    }
  }

  private canRestoreFocus(element: HTMLElement | null, doc: Document): element is HTMLElement {
    return Boolean(element && element !== doc.body && element.ownerDocument === doc && element.isConnected !== false
      && !this.surface.contains(element) && !(element as HTMLButtonElement).disabled
      && element.getAttribute("aria-disabled") !== "true" && element.getAttribute("hidden") === null
      && (typeof element.checkVisibility !== "function" || element.checkVisibility({ checkVisibilityCSS: true })));
  }

  private focusTarget(doc: Document): HTMLElement | null {
    if (this.canRestoreFocus(this.previousFocus, doc)) return this.previousFocus;
    const roots = new Set([
      this.surface.closest<HTMLElement>(".cc-chat-root") ?? this.surface.closest<HTMLElement>(".cc-root"),
      this.ownerPane,
      ...[...hosts].filter(entry => visible(entry, doc)).map(entry => entry.root),
    ]);
    for (const root of roots) {
      if (!root || root.isConnected === false) continue;
      for (const selector of [".cc-input", ".cc-model", ".cc-sessions-btn", ".cc-companion-quick-options"]) {
        const target = root.querySelector<HTMLElement>(selector);
        if (this.canRestoreFocus(target, doc)) return target;
      }
    }
    return null;
  }

  override hide(): void {
    const doc = this.surface.ownerDocument;
    const target = this.surface.contains(doc.activeElement) ? this.focusTarget(doc) : null;
    super.hide();
    target?.focus({ preventScroll: true });
  }

  override setMessage(message: string | DocumentFragment): this {
    super.setMessage(message);
    if (this.dismissButton) this.attachDismiss();
    return this;
  }
}

/** The host participates in pane flow, after the entire header rather than an actions row. */
export function mountFeedbackHost(root: HTMLElement): () => void {
  const host = root.createDiv({ cls: "cc-feedback-host", attr: { role: "status", "aria-live": "polite", "aria-atomic": "false", "aria-relevant": "additions text" } });
  const header = root.querySelector<HTMLElement>(".cc-header") ?? root.querySelector<HTMLElement>(".cc-companion-chrome");
  if (header?.parentElement === root) root.insertBefore(host, header.nextSibling);
  const entry = { root, host };
  hosts.add(entry);
  const prefer = (): void => { preferred = entry; };
  root.addEventListener("focusin", prefer);
  root.addEventListener("pointerdown", prefer);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    hosts.delete(entry);
    if (preferred === entry) preferred = undefined;
    root.removeEventListener("focusin", prefer);
    root.removeEventListener("pointerdown", prefer);
    for (const notice of [...host.children]) destination(host.ownerDocument).appendChild(notice);
    host.remove();
  };
}

export function quickNotice(message: string): Notice {
  return new CompanionNotice(message, QUICK_NOTICE_MS);
}
