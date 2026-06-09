const HTML_ARTIFACT_FENCE_RE = /```(?:claude-html|codex-html)\b/i;

export function shouldRenderMarkdownDuringStream(markdown: string): boolean {
  return !HTML_ARTIFACT_FENCE_RE.test(markdown);
}

export function hasIncompleteHtmlArtifactFence(markdown: string): boolean {
  const opening = HTML_ARTIFACT_FENCE_RE.exec(markdown);
  if (!opening) return false;
  const afterOpening = markdown.slice(opening.index + opening[0].length);
  return !/(^|\n)```\s*(\n|$)/.test(afterOpening);
}
