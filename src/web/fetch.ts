// Agent-side web fetch: read one public page as readable markdown (Defuddle via
// captureWebSource). Explicit tool calls only — never fires in the background.

import { captureWebSource, type WebCaptureIo } from "../research/webCapture";

const MAX_PAGE = 12000;

/** Fetch a page and return title + readable markdown, bounded for a tool result. */
export async function webFetch(url: string, io: WebCaptureIo): Promise<string> {
  const captured = await captureWebSource(url, io);
  if (!captured) throw new Error(`Could not extract readable content from: ${url}`);
  const body = captured.markdown.length > MAX_PAGE ? `${captured.markdown.slice(0, MAX_PAGE)}\n[truncated — page continues]` : captured.markdown;
  return captured.title ? `# ${captured.title}\n\n${body}` : body;
}
