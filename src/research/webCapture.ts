// Clean web-source capture: fetch a page and extract readable markdown with
// Defuddle (MIT, Steph Ango — the engine behind Obsidian Web Clipper), so a
// pasted URL becomes trustworthy captured text with a content fingerprint
// instead of a bare link. IO injected; DOM parsing supplied by the caller.

import Defuddle from "defuddle";
import { safeWebUrl } from "../discovery/safeUrl";

export interface WebCaptureIo {
  /** Fetch the page body (e.g. Obsidian requestUrl). Throws on network failure. */
  fetchHtml: (url: string) => Promise<string>;
  /** Parse HTML into a Document (DOMParser in the app, linkedom in tests). */
  parseHtml: (html: string) => Document;
}

export interface WebCaptureResult {
  markdown: string;
  title?: string;
  author?: string;
  published?: string;
}

export type WebCapture = (url: string) => Promise<WebCaptureResult | undefined>;

/**
 * Capture a web page as readable markdown. Returns undefined when the URL is
 * not plain http(s) or no article content survives extraction. useAsync stays
 * off so Defuddle never contacts third-party extractor APIs.
 */
export async function captureWebSource(url: string, io: WebCaptureIo): Promise<WebCaptureResult | undefined> {
  const safe = safeWebUrl(url);
  if (!safe) return undefined;
  const html = await io.fetchHtml(safe);
  if (!html.trim()) return undefined;
  const doc = io.parseHtml(html);
  const parsed = new Defuddle(doc, { url: safe, markdown: true, useAsync: false }).parse();
  const markdown = parsed.content?.trim();
  if (!markdown) return undefined;
  return {
    markdown,
    ...(parsed.title?.trim() ? { title: parsed.title.trim() } : {}),
    ...(parsed.author?.trim() ? { author: parsed.author.trim() } : {}),
    ...(parsed.published?.trim() ? { published: parsed.published.trim() } : {}),
  };
}
