// Re-export the Defuddle-based capture so chat (and other non-research
// surfaces) can attach page content without importing the research module.
// The research paths keep importing research/webCapture directly.

export { captureWebSource } from "../research/webCapture";
export type { WebCapture, WebCaptureIo, WebCaptureResult } from "../research/webCapture";
