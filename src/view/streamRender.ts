// A `claude-html`/`codex-html` artifact fence — the blocks that render as a
// sandboxed iframe. Used for the abort-persist decision (only a real artifact
// gets the "not saved" treatment).
const HTML_ARTIFACT_FENCE_RE = /```(?:claude-html|codex-html)\b/i;

// Anything that would make Obsidian's MarkdownRenderer paint a big raw-HTML
// document mid-stream: an html-ish code fence, OR a bare HTML document the model
// emitted without fencing (MarkdownRenderer renders inline HTML as real HTML, so
// a streamed `<h1>`/`<style>` shows up as giant headings — the "large font" bug).
// The bare-doc markers are anchored to the start of a line so inline prose that
// merely mentions `<html>` (e.g. in backticks) still streams as markdown.
const HTML_STREAM_RE = /```(?:claude-html|codex-html|html)\b|(?:^|\n)\s*(?:<!doctype\s+html|<html[\s>]|<body[\s>])/i;

export function shouldRenderMarkdownDuringStream(markdown: string): boolean {
  return !HTML_STREAM_RE.test(markdown);
}

export function hasIncompleteHtmlArtifactFence(markdown: string): boolean {
  const opening = HTML_ARTIFACT_FENCE_RE.exec(markdown);
  if (!opening) return false;
  const afterOpening = markdown.slice(opening.index + opening[0].length);
  return !/(^|\n)```\s*(\n|$)/.test(afterOpening);
}

/**
 * Split a streaming buffer at the first html-ish marker. While HTML is streaming
 * we don't want to dump its raw source (or render it as real HTML) into the chat —
 * `before` is the prose that preceded the marker (rendered as markdown) and
 * `streamingArtifact` says HTML is in flight (show a "building" chip in its place
 * until the final render swaps in the sandboxed iframe / code block).
 */
export function splitStreamingArtifact(markdown: string): { before: string; streamingArtifact: boolean } {
  const opening = HTML_STREAM_RE.exec(markdown);
  if (!opening) return { before: markdown, streamingArtifact: false };
  return { before: markdown.slice(0, opening.index), streamingArtifact: true };
}
