import { describe, it, expect } from "vitest";
import { detectType, parseClipUrl } from "../../src/sources/detect";

describe("parseClipUrl", () => {
  it("reads the clipper's source/url frontmatter key", () => {
    expect(parseClipUrl("---\nsource: https://example.com/a\n---\nbody")).toBe("https://example.com/a");
    expect(parseClipUrl('---\nurl: "https://youtu.be/abc"\n---')).toBe("https://youtu.be/abc");
    expect(parseClipUrl("no frontmatter")).toBeUndefined();
  });
});

describe("detectType", () => {
  it("classifies a data file as dataset", () => {
    expect(detectType({ kind: "datafile", path: "Clippings/x.csv", basename: "x", ext: "csv", content: "a,b\n1,2" })).toBe("dataset");
  });
  it("classifies a youtube url as video", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/v.md", basename: "v", content: "---\nsource: https://www.youtube.com/watch?v=1\n---" })).toBe("video");
  });
  it("uses an explicit capture.url over frontmatter", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/v.md", basename: "v", content: "no fm", url: "https://youtu.be/xyz" })).toBe("video");
  });
  it("defaults to article", () => {
    expect(detectType({ kind: "markdown", path: "Clippings/a.md", basename: "a", content: "---\nsource: https://stratechery.com/p\n---" })).toBe("article");
  });
});
