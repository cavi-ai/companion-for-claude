import { describe, expect, it } from "vitest";
import { hasIncompleteHtmlArtifactFence, shouldRenderMarkdownDuringStream } from "../src/view/streamRender";

describe("shouldRenderMarkdownDuringStream", () => {
  it("allows ordinary markdown to render while streaming", () => {
    expect(shouldRenderMarkdownDuringStream("## Heading\n\n- one\n- two")).toBe(true);
  });

  it("holds claude-html artifacts until the final render", () => {
    const artifact = [
      "```claude-html",
      "<!doctype html><html><head><title>Dash</title></head><body>hi</body></html>",
      "```",
    ].join("\n");

    expect(shouldRenderMarkdownDuringStream(artifact)).toBe(false);
  });

  it("holds partially streamed claude-html artifacts too", () => {
    expect(shouldRenderMarkdownDuringStream("```claude-html\n<!doctype html><html>")).toBe(false);
  });

  it("detects interrupted html artifact fences", () => {
    expect(hasIncompleteHtmlArtifactFence("```claude-html\n<!doctype html><html>")).toBe(true);
    expect(hasIncompleteHtmlArtifactFence("```codex-html\n<div>ok</div>\n```")).toBe(false);
    expect(hasIncompleteHtmlArtifactFence("## ordinary markdown")).toBe(false);
  });
});
