// URL context in chat (spec 2026-07-22 user-value roadmap, §7): a URL typed or
// pasted into the composer can be attached as captured page content. Detection
// and the attached-page shape are pure; the fetch itself goes through
// context/webCapture (Defuddle) on explicit user action only.

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
