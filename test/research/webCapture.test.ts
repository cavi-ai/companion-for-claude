import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { captureWebSource, redditPostUrl, type WebCaptureIo } from "../../src/research/webCapture";

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

// Obsidian's htmlToMarkdown in the app; the identity keeps assertions on the extracted text.
const toMarkdown = (html: string) => html;

function io(html: string): WebCaptureIo {
  return {
    fetchHtml: vi.fn(async () => html),
    parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
    toMarkdown,
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

  it("returns the extracted content converted to markdown", async () => {
    const convert = vi.fn(() => "  # Converted\n");
    const result = await captureWebSource("https://example.test/effects", { ...io(ARTICLE_HTML), toMarkdown: convert });
    expect(convert).toHaveBeenCalledWith(expect.stringContaining("Measured effects replicate across cohorts"));
    expect(result?.markdown).toBe("# Converted");
  });

  it("returns undefined when the page yields no content", async () => {
    expect(await captureWebSource("https://example.test/empty", io(""))).toBeUndefined();
  });

  it("propagates fetch failures to the caller", async () => {
    const failing: WebCaptureIo = {
      fetchHtml: async () => { throw new Error("HTTP 503"); },
      parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
      toMarkdown,
    };
    await expect(captureWebSource("https://example.test/down", failing)).rejects.toThrow("HTTP 503");
  });
});

// A Reddit share link (`/r/<sub>/s/<code>`) redirects to the post page, whose
// server HTML names the post but carries no body for link and media posts.
const SHARE_PAGE = `<!DOCTYPE html>
<html><head>
  <title>Run it locally : r/unsloth</title>
  <link rel="canonical" href="https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/">
</head><body>
  <shreddit-post permalink="/r/unsloth/comments/1abc23/run_it_locally/" author="poster"></shreddit-post>
</body></html>`;

const POST_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Run it locally : unsloth</title>
  <entry>
    <author><name>/u/poster</name></author>
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;The post body explains how to run the model on one GPU.&lt;/p&gt;&lt;/div&gt;</content>
    <id>t3_1abc23</id>
    <link href="https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/"/>
    <updated>2026-10-20T09:00:00+00:00</updated>
    <title>Run it locally</title>
  </entry>
  <entry>
    <author><name>/u/replier</name></author>
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;A reply about quantization settings.&lt;/p&gt;&lt;/div&gt;</content>
    <id>t1_c1</id>
    <link href="https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/c1/"/>
    <updated>2026-10-20T10:00:00+00:00</updated>
    <title>/u/replier on Run it locally</title>
  </entry>
</feed>`;

function redditIo(page: string, feed: () => Response): WebCaptureIo & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetchHtml: vi.fn(async () => page),
    parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
    toMarkdown,
    // Mirrors Reddit today: old.reddit.com answers anonymous clients with a login page.
    fetch: vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "old.reddit.com") return new Response("<html><body><form id=\"login\"></form></body></html>");
      if (url.hostname === "www.reddit.com" && url.pathname.endsWith("/.rss")) return feed();
      throw new Error(`unexpected request: ${url.href}`);
    }),
  };
}

describe("captureWebSource on Reddit", () => {
  it("follows a share link to its post and reads the post and replies from Reddit's feed", async () => {
    const target = redditIo(SHARE_PAGE, () => new Response(POST_FEED));
    const result = await captureWebSource("https://www.reddit.com/r/unsloth/s/3rCTTgaPdB", target);
    expect(result?.markdown).toContain("run the model on one GPU");
    expect(result?.markdown).toContain("quantization settings");
    expect(result?.title).toBe("Run it locally");
    const requested = target.fetch.mock.calls.map(([input]) => String(input));
    expect(requested).toContain("https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/.rss");
    expect(new Set(requested.map((url) => new URL(url).hostname))).toEqual(new Set(["old.reddit.com", "www.reddit.com"]));
  });

  it("keeps the post text the page carries when the feed refuses", async () => {
    const page = SHARE_PAGE.replace(
      '<shreddit-post permalink="/r/unsloth/comments/1abc23/run_it_locally/" author="poster"></shreddit-post>',
      '<h1>Run it locally</h1><shreddit-post permalink="/r/unsloth/comments/1abc23/run_it_locally/" author="poster"><div slot="text-body"><p>Body text served in the page itself.</p></div></shreddit-post>',
    );
    const result = await captureWebSource("https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/", redditIo(page, () => new Response("", { status: 429 })));
    expect(result?.markdown).toContain("Body text served in the page itself.");
  });

  it("reads only the page when no fetch is supplied", async () => {
    const target = redditIo(SHARE_PAGE, () => new Response(POST_FEED));
    const { fetch: _unused, ...pageOnly } = target;
    expect(await captureWebSource("https://www.reddit.com/r/unsloth/s/3rCTTgaPdB", pageOnly)).toBeUndefined();
    expect(target.fetch).not.toHaveBeenCalled();
  });
});

describe("redditPostUrl", () => {
  const doc = (html: string) => parseHTML(html).document as unknown as Document;

  it("drops the share tracking from a post URL", () => {
    expect(redditPostUrl("https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/?share_id=x&utm_source=share", doc("<html></html>")))
      .toBe("https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/");
  });

  it("takes a share link's post from the page it redirected to", () => {
    expect(redditPostUrl("https://www.reddit.com/r/unsloth/s/3rCTTgaPdB", doc(SHARE_PAGE)))
      .toBe("https://www.reddit.com/r/unsloth/comments/1abc23/run_it_locally/");
  });

  it("ignores pages that are not Reddit posts and canonicals that leave Reddit", () => {
    expect(redditPostUrl("https://example.test/r/unsloth/comments/1abc23/", doc("<html></html>"))).toBeUndefined();
    expect(redditPostUrl("https://www.reddit.com/r/unsloth/", doc("<html></html>"))).toBeUndefined();
    expect(redditPostUrl("https://www.reddit.com/r/unsloth/s/3rCTTgaPdB", doc('<link rel="canonical" href="https://evil.test/r/unsloth/comments/1abc23/">'))).toBeUndefined();
  });
});
