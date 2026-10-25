// YouTube transcripts through Defuddle's YouTube extractor: fetch the watch page
// and let the extractor read the caption track from youtube.com. Runs only when
// the user opens a video's living view; IO injected.

import Defuddle from "defuddle";
import { safeWebUrl } from "../discovery/safeUrl";
import type { WebCaptureIo } from "../research/webCapture";
import { parseTranscript, youtubeId, type Transcript } from "./transcript";

export interface VideoTranscriptIo extends Pick<WebCaptureIo, "fetchHtml" | "parseHtml"> {
  /** Fetch for the extractor's own requests (e.g. Obsidian's requestUrl behind the fetch API). */
  fetch: typeof fetch;
}

/** The video's transcript, or null when the URL is not a YouTube video or it has no captions. */
export async function fetchVideoTranscript(url: string, io: VideoTranscriptIo): Promise<Transcript | null> {
  const safe = safeWebUrl(url);
  if (!safe || !youtubeId(safe)) return null;
  const html = await io.fetchHtml(safe);
  if (!html.trim()) return null;
  const result = await new Defuddle(io.parseHtml(html), { url: safe, markdown: true, useAsync: true, fetch: io.fetch }).parseAsync();
  const text = result.variables?.transcript;
  return typeof text === "string" ? parseTranscript(text) : null;
}
