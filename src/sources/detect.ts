import type { RawCapture, SourceType } from "./types";

/** Read the URL the Web Clipper stamps into frontmatter (`source:` or `url:`). */
export function parseClipUrl(content: string): string | undefined {
  const m = /^(?:source|url):\s*["']?(\S+?)["']?\s*$/m.exec(content);
  return m ? m[1] : undefined;
}

/** A `type:` stamp from a Companion-generated clipper template wins outright. */
export function parseStampedType(content: string): SourceType | undefined {
  const m = /^type:\s*["']?(article|video|dataset)["']?\s*$/m.exec(content);
  return m ? (m[1] as SourceType) : undefined;
}

/** Classify a capture into a source type. Extension wins; then a stamped type;
 *  then URL host; default article. */
export function detectType(capture: RawCapture): SourceType {
  if (capture.kind === "datafile") return "dataset";
  const stamped = parseStampedType(capture.content);
  if (stamped) return stamped;
  // Classify on the clip's stamped source URL only — a YouTube link merely
  // mentioned in an article body must not flip it to a video.
  const url = capture.url ?? parseClipUrl(capture.content) ?? "";
  if (/(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts)/i.test(url)) return "video";
  return "article";
}
