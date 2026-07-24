import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { captureWebSource, type WebCaptureIo } from "../../src/research/webCapture";

const ARTICLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Effect Sizes in the Wild</title>
  <meta name="author" content="Ada Lovelace">
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <div class="ad-banner">Buy things! Subscribe now!</div>
  <article>
    <h1>Effect Sizes in the Wild</h1>
    <p>Measured effects replicate across cohorts when instruments are calibrated.
    This paragraph carries the substance of the article and is long enough for
    content scoring to keep it as the main body of the extracted page.</p>
    <p>A second paragraph adds methodological detail about calibration windows,
    sampling cadence, and the preregistered analysis plan used in every cohort.</p>
  </article>
  <footer>© Example Journal — cookie policy, social links</footer>
  <script>trackEverything();</script>
</body>
</html>`;

function io(html: string): WebCaptureIo {
  return {
    fetchHtml: vi.fn(async () => html),
    parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
  };
}

describe("captureWebSource", () => {
  it("extracts readable markdown and metadata, dropping boilerplate and scripts", async () => {
    const result = await captureWebSource("https://example.test/effects", io(ARTICLE_HTML));
    expect(result).toBeDefined();
    expect(result!.markdown).toContain("Measured effects replicate across cohorts");
    expect(result!.markdown).not.toContain("trackEverything");
    expect(result!.markdown).not.toContain("Subscribe now");
    expect(result!.title).toBe("Effect Sizes in the Wild");
    expect(result!.author).toBe("Ada Lovelace");
  });

  it("refuses non-http(s) URLs without fetching", async () => {
    const target = io(ARTICLE_HTML);
    expect(await captureWebSource("javascript:alert(1)", target)).toBeUndefined();
    expect(await captureWebSource("file:///etc/passwd", target)).toBeUndefined();
    expect(await captureWebSource("not a url", target)).toBeUndefined();
    expect(target.fetchHtml).not.toHaveBeenCalled();
  });

  it("returns undefined when the page yields no content", async () => {
    expect(await captureWebSource("https://example.test/empty", io(""))).toBeUndefined();
  });

  it("propagates fetch failures to the caller", async () => {
    const failing: WebCaptureIo = {
      fetchHtml: async () => { throw new Error("HTTP 503"); },
      parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
    };
    await expect(captureWebSource("https://example.test/down", failing)).rejects.toThrow("HTTP 503");
  });
});
