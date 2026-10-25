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
  /**
   * Turn Defuddle's cleaned HTML into markdown (Obsidian's htmlToMarkdown in
   * the app). The core Defuddle build returns HTML whatever its options say;
   * its markdown converter ships only in the much larger full build.
   */
  toMarkdown: (html: string) => string;
  /**
   * Fetch for a site's own feed (Reddit posts). Without it a Reddit post is
   * read from its page HTML only: no comments, and no body for a link or
   * media post.
   */
  fetch?: typeof fetch;
}

export interface WebCaptureResult {
  markdown: string;
  title?: string;
  author?: string;
  published?: string;
}

export type WebCapture = (url: string) => Promise<WebCaptureResult | undefined>;

const REDDIT_HOST = /(?:^|\.)reddit\.com$/i;
const REDDIT_POST_PATH = /^\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/|$)/i;

/**
 * The canonical post URL for a Reddit page: the URL itself, or for a share
 * link (`/r/<sub>/s/<code>`, which redirects) the post the fetched page names.
 * Query and fragment are dropped so the feed URL derived from it is clean.
 */
export function redditPostUrl(url: string, doc: Document): string | undefined {
  if (!REDDIT_HOST.test(new URL(url).hostname)) return undefined;
  const candidates = [
    url,
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    doc.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    doc.querySelector("shreddit-post")?.getAttribute("permalink"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let post: URL;
    try {
      post = new URL(candidate, "https://www.reddit.com");
    } catch {
      continue;
    }
    if (post.protocol !== "https:" || !REDDIT_HOST.test(post.hostname) || !REDDIT_POST_PATH.test(post.pathname)) continue;
    post.search = "";
    post.hash = "";
    return post.href;
  }
  return undefined;
}

/** A fetch that only reaches Reddit, so the extractor's feed requests stay first-party. */
function redditOnlyFetch(send: typeof fetch): typeof fetch {
  return (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!REDDIT_HOST.test(new URL(target).hostname)) return Promise.reject(new Error(`Refused a non-Reddit request: ${target}`));
    return send(input, init);
  };
}

/**
 * Capture a web page as readable markdown. Returns undefined when the URL is
 * not plain http(s) or no article content survives extraction. useAsync stays
 * off so Defuddle never contacts third-party extractor APIs; a Reddit post is
 * the one exception, read from Reddit's own feed through `io.fetch`.
 */
export async function captureWebSource(url: string, io: WebCaptureIo): Promise<WebCaptureResult | undefined> {
  const safe = safeWebUrl(url);
  if (!safe) return undefined;
  const html = await io.fetchHtml(safe);
  if (!html.trim()) return undefined;
  const doc = io.parseHtml(html);
  const send = io.fetch;
  const reddit = send ? redditPostUrl(safe, doc) : undefined;
  const parsed = send && reddit
    ? await new Defuddle(doc, { url: reddit, useAsync: true, fetch: redditOnlyFetch(send) }).parseAsync()
    : new Defuddle(doc, { url: safe, useAsync: false }).parse();
  const markdown = parsed.content?.trim() ? io.toMarkdown(parsed.content).trim() : "";
  if (!markdown) return undefined;
  return {
    markdown,
    ...(parsed.title?.trim() ? { title: parsed.title.trim() } : {}),
    ...(parsed.author?.trim() ? { author: parsed.author.trim() } : {}),
    ...(parsed.published?.trim() ? { published: parsed.published.trim() } : {}),
  };
}
