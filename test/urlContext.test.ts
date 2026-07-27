import { describe, it, expect } from "vitest";
import { detectPageUrl, pageLabel } from "../src/context/urlContext";

describe("detectPageUrl", () => {
  it("finds the first http(s) URL in prose", () => {
    expect(detectPageUrl("read https://example.com/a?b=1#frag please")).toBe("https://example.com/a?b=1#frag");
    expect(detectPageUrl("http://a.dev/x then https://b.dev/y")).toBe("http://a.dev/x");
  });

  it("trims trailing sentence punctuation glued to the URL", () => {
    expect(detectPageUrl("see https://example.com.")).toBe("https://example.com");
    expect(detectPageUrl("(https://example.com/a),")).toBe("https://example.com/a");
  });

  it("stops at whitespace, brackets, and quotes", () => {
    expect(detectPageUrl("[link](https://example.com/a)")).toBe("https://example.com/a");
    expect(detectPageUrl('"https://example.com/a"')).toBe("https://example.com/a");
  });

  it("returns null without a usable URL", () => {
    expect(detectPageUrl("no url here")).toBeNull();
    expect(detectPageUrl("ftp://example.com")).toBeNull();
    expect(detectPageUrl("https://")).toBeNull();
  });
});

describe("pageLabel", () => {
  it("shows host plus a non-root path", () => {
    expect(pageLabel("https://example.com/blog/post/")).toBe("example.com/blog/post");
    expect(pageLabel("https://example.com/")).toBe("example.com");
  });

  it("falls back to the raw string for unparseable URLs", () => {
    expect(pageLabel("not a url")).toBe("not a url");
  });
});
