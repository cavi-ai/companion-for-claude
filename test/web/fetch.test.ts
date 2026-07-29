import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { webFetch } from "../../src/web/fetch";
import type { WebCaptureIo } from "../../src/research/webCapture";

const ARTICLE = `<!DOCTYPE html><html><head><title>Readable Page</title></head>
<body><article><h1>Readable Page</h1>
<p>The substance of the page lives in this paragraph, long enough for content
scoring to keep it as the article body rather than boilerplate around it.</p>
<p>A second paragraph of real content ensures the extractor keeps the article
and does not fall back to an empty capture result for this fixture page.</p>
</article></body></html>`;

function io(html: string): WebCaptureIo {
  return {
    fetchHtml: async () => html,
    parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
  };
}

describe("webFetch", () => {
  it("returns the page title plus readable markdown", async () => {
    const text = await webFetch("https://example.test/article", io(ARTICLE));
    expect(text).toContain("# Readable Page");
    expect(text).toContain("substance of the page");
  });

  it("throws an actionable error when nothing readable survives", async () => {
    await expect(webFetch("https://example.test/empty", io("   "))).rejects.toThrow(/could not extract/i);
  });

  it("rejects non-http URLs before fetching", async () => {
    await expect(webFetch("file:///etc/passwd", io(ARTICLE))).rejects.toThrow(/could not extract/i);
  });
});
