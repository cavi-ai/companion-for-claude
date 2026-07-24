import { describe, expect, it } from "vitest";
import { hasIncompleteHtmlArtifactFence, shouldRenderMarkdownDuringStream, splitStreamingArtifact } from "../src/view/streamRender";

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

  it("holds bare/unfenced HTML documents (the 'large font' leak)", () => {
    expect(shouldRenderMarkdownDuringStream("<!doctype html>\n<html><body><h1>Hi")).toBe(false);
    expect(shouldRenderMarkdownDuringStream("Here you go:\n\n<html>\n<h1>Big</h1>")).toBe(false);
    expect(shouldRenderMarkdownDuringStream("```html\n<h1>fenced</h1>\n```")).toBe(false);
  });

  it("still streams ordinary markdown that merely mentions html", () => {
    expect(shouldRenderMarkdownDuringStream("Use the `<html>` tag — set `lang`.")).toBe(true);
    expect(shouldRenderMarkdownDuringStream("## HTML tips\n\n- close your tags")).toBe(true);
  });

  it("detects interrupted html artifact fences", () => {
    expect(hasIncompleteHtmlArtifactFence("```claude-html\n<!doctype html><html>")).toBe(true);
    expect(hasIncompleteHtmlArtifactFence("```codex-html\n<div>ok</div>\n```")).toBe(false);
    expect(hasIncompleteHtmlArtifactFence("## ordinary markdown")).toBe(false);
  });
});

describe("splitStreamingArtifact", () => {
  it("returns the whole buffer as prose when no artifact fence is present", () => {
    expect(splitStreamingArtifact("Here is a plan\n\n- one")).toEqual({
      before: "Here is a plan\n\n- one",
      streamingArtifact: false,
    });
  });

  it("splits lead-in prose from a streaming artifact", () => {
    const buffer = "Here's your dashboard:\n\n```claude-html\n<!doctype html><html>";
    expect(splitStreamingArtifact(buffer)).toEqual({
      before: "Here's your dashboard:\n\n",
      streamingArtifact: true,
    });
  });

  it("flags an artifact with no lead-in prose (empty before)", () => {
    expect(splitStreamingArtifact("```claude-html\n<div>hi</div>")).toEqual({
      before: "",
      streamingArtifact: true,
    });
  });

  it("also splits codex-html artifacts", () => {
    expect(splitStreamingArtifact("intro ```codex-html\n<div>").streamingArtifact).toBe(true);
  });
});
