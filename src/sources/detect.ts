import type { RawCapture, SourceType } from "./types";
import { prepareSourceMarkdown } from "./sourceMarkdown";

/** Prefer a non-empty source string, then the url property. */
export function sourceUrlFromProperties(properties: Readonly<Record<string, unknown>>): string | undefined {
  for (const value of [properties.source, properties.url]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Read the URL the Web Clipper stamps into frontmatter (`source:` or `url:`). */
export function parseClipUrl(content: string): string | undefined {
  return sourceUrlFromProperties(prepareSourceMarkdown(content).properties);
}

/** A `type:` stamp from a Companion-generated clipper template wins outright. */
export function parseStampedType(content: string): SourceType | undefined {
  const type = prepareSourceMarkdown(content).properties.type;
  return type === "article" || type === "video" || type === "dataset" ? type : undefined;
}

/** Classify a capture into a source type. Extension wins; then a stamped type;
 *  then URL host; default article. */
export function detectType(capture: RawCapture): SourceType {
  if (capture.kind === "datafile") return "dataset";
  const stamped = parseStampedType(capture.content);
  if (stamped) return stamped;
  // Classify on the clip's stamped source URL only — a YouTube link merely
  // mentioned in an article body must not flip it to a video.
  try {
    const url = new URL(capture.url ?? parseClipUrl(capture.content) ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return "article";
    const youtube = /(?:^|\.)youtube\.com$/.test(url.hostname)
      && (url.pathname === "/watch" || /^\/shorts\/[^/]+/.test(url.pathname));
    const short = /^(?:www\.)?youtu\.be$/.test(url.hostname) && url.pathname.length > 1;
    if (youtube || short) return "video";
  } catch { /* Missing or invalid source URL: use the article schema. */ }
  return "article";
}
