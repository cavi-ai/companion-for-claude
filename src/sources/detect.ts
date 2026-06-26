import type { RawCapture, SourceType } from "./types";

/** Read the URL the Web Clipper stamps into frontmatter (`source:` or `url:`). */
export function parseClipUrl(content: string): string | undefined {
  const m = /^(?:source|url):\s*["']?(\S+?)["']?\s*$/m.exec(content);
  return m ? m[1] : undefined;
}

/** Classify a capture into a source type. Extension wins; then URL host; default article. */
export function detectType(capture: RawCapture): SourceType {
  if (capture.kind === "datafile") return "dataset";
  // Classify on the clip's stamped source URL only — a YouTube link merely
  // mentioned in an article body must not flip it to a video.
  const url = capture.url ?? parseClipUrl(capture.content) ?? "";
  if (/(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts)/i.test(url)) return "video";
  return "article";
}
