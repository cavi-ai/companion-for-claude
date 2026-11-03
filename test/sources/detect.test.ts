import { describe, it, expect } from "vitest";
import { detectType, parseClipUrl, parseStampedType } from "../../src/sources/detect";

describe("parseClipUrl", () => {
  it("reads the clipper's source/url frontmatter key", () => {
    expect(parseClipUrl("---\nsource: https://example.com/a\n---\nbody")).toBe("https://example.com/a");
    expect(parseClipUrl('---\nurl: "https://youtu.be/abc"\n---')).toBe("https://youtu.be/abc");
    expect(parseClipUrl("no frontmatter")).toBeUndefined();
  });

  it.each(['""', '"  "', '[]', 'false'])("falls back to url when source has no URL string: %s", (source) => {
    expect(parseClipUrl(`---\nsource: ${source}\nurl: https://example.com/article\n---\n`)).toBe("https://example.com/article");
  });
});

describe("detectType", () => {
  it("classifies a data file as dataset", () => {
    expect(detectType({ kind: "datafile", path: "Clippings/x.csv", basename: "x", ext: "csv", content: "a,b\n1,2" })).toBe("dataset");
  });
  it("classifies a youtube url as video", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/v.md", basename: "v", content: "---\nsource: https://www.youtube.com/watch?v=1\n---" })).toBe("video");
  });
  it.each([
    "https://notyoutube.com/watch?v=1",
    "https://example.com/youtube.com/watch?v=1",
    "https://example.com/?next=https://youtu.be/abc",
    "https://www.youtube.com/watchlist",
    "ftp://www.youtube.com/watch?v=1",
  ])("does not classify a non-video source as YouTube: %s", (url) => {
    expect(detectType({ kind: "markdown", path: "Clippings/a.md", basename: "a", content: "", url })).toBe("article");
  });
  it.each([
    "https://www.youtube.com/watch?v=1",
    "https://m.youtube.com/shorts/abc",
    "https://youtu.be/abc",
  ])("recognizes supported YouTube source URLs: %s", (url) => {
    expect(detectType({ kind: "markdown", path: "Clippings/v.md", basename: "v", content: "", url })).toBe("video");
  });
  it("uses an explicit capture.url over frontmatter", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/v.md", basename: "v", content: "no fm", url: "https://youtu.be/xyz" })).toBe("video");
  });
  it("defaults to article", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/a.md", basename: "a", content: "---\nsource: https://stratechery.com/p\n---" })).toBe("article");
  });
  it("trusts a stamped type from a clipper template over the URL", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/v.md", basename: "v", content: "---\ntype: video\nsource: https://example.com/page\n---" })).toBe("video");
    expect(detectType({ kind: "markdown", path: "Clippings/a.md", basename: "a", content: "---\ntype: article\nsource: https://www.youtube.com/watch?v=1\n---" })).toBe("article");
  });
});

describe("parseStampedType", () => {
  it("reads a known type stamp and rejects unknown ones", () => {
    expect(parseStampedType("---\ntype: dataset\n---")).toBe("dataset");
    expect(parseStampedType('---\ntype: "video"\n---')).toBe("video");
    expect(parseStampedType("---\ntype: project\n---")).toBeUndefined();
    expect(parseStampedType("no frontmatter")).toBeUndefined();
  });
});
