// URL context in chat (spec 2026-07-22 user-value roadmap, §7): a URL typed or
// pasted into the composer can be attached as captured page content. Detection
// and the attached-page shape are pure; the fetch itself goes through
// context/webCapture (Defuddle) on explicit user action only.

/** A captured page contributes at most this many characters to one request. */
export const MAX_PAGE_CONTEXT_CHARS = 6000;

export interface AttachedPage {
  url: string;
  /** Page title when capture succeeded. */
  title?: string;
  /** Captured clean markdown; empty while pending or after a failure. */
  markdown: string;
  /** Set when the fetch failed — shown on the pill, never thrown into chat. */
  error?: string;
  /** True while the capture is in flight. */
  pending?: boolean;
}

/** Take a request-local copy only after every explicitly selected capture is usable. */
export function snapshotPages(pages: readonly AttachedPage[]): AttachedPage[] {
  return pages.map((page) => {
    if (page.pending) throw new Error(`Still capturing ${page.url}. Wait for capture to finish or remove the page from Message context, then send again.`);
    if (page.error) throw new Error(`Couldn't capture ${page.url}: ${page.error}. Retry capture or remove the page from Message context, then send again.`);
    if (!page.markdown.trim()) throw new Error(`No readable content was captured from ${page.url}. Retry capture or remove the page from Message context, then send again.`);
    return { url: page.url, markdown: page.markdown, ...(page.title !== undefined ? { title: page.title } : {}) };
  });
}

const URL_RE = /https?:\/\/[^\s<>"'()\]]+/i;

/**
 * The first http(s) URL in the text, or null. Trailing punctuation glued on by
 * prose ("see https://x.dev.") is trimmed.
 */
export function detectPageUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  const trimmed = m[0].replace(/[.,;:!?]+$/, "");
  return trimmed.length > "https://".length ? trimmed : null;
}

/** Host (+path hint) for compact pill/offer labels. */
export function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "");
  } catch {
    return url;
  }
}
