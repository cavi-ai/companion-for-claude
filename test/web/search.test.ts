import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { DiscoveryHttp } from "../../src/discovery/adapters/http";
import { braveSearch, duckDuckGoSearch, formatSearchResults, type DuckDuckGoIo } from "../../src/web/search";

const DDG_HTML = `<!DOCTYPE html><html><body>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Farticle&rut=abc">Local-first notes, explained</a>
  <a class="result__snippet">Why keeping your   markdown local wins.</a>
</div>
<div class="result">
  <a class="result__a" href="https://direct.test/page">A direct link result</a>
  <a class="result__snippet">Second snippet.</a>
</div>
<div class="result">
  <a class="result__a" href="javascript:void(0)">Ad result with no real target</a>
</div>
</body></html>`;

function ddgIo(html: string): DuckDuckGoIo & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchHtml: async (url: string) => {
      urls.push(url);
      return html;
    },
    parseHtml: (value: string) => parseHTML(value).document as unknown as Document,
  };
}

const jsonResponse = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });

describe("duckDuckGoSearch", () => {
  it("parses results, unwraps redirect links, skips non-http targets, and caps the count", async () => {
    const io = ddgIo(DDG_HTML);
    const results = await duckDuckGoSearch(io, "local-first notes", 5);
    expect(results).toEqual([
      { title: "Local-first notes, explained", url: "https://example.test/article", snippet: "Why keeping your markdown local wins." },
      { title: "A direct link result", url: "https://direct.test/page", snippet: "Second snippet." },
    ]);
    expect(io.urls[0]).toContain("html.duckduckgo.com/html/?q=local-first%20notes");

    const capped = await duckDuckGoSearch(ddgIo(DDG_HTML), "q", 1);
    expect(capped).toHaveLength(1);
  });

  it("returns an empty list when the page has no results", async () => {
    expect(await duckDuckGoSearch(ddgIo("<html><body></body></html>"), "q", 5)).toEqual([]);
  });
});

describe("braveSearch", () => {
  const http = (body: unknown, status = 200): { http: DiscoveryHttp; urls: string[]; headers: Record<string, string> | undefined } => {
    const urls: string[] = [];
    let headers: Record<string, string> | undefined;
    return {
      urls,
      get headers() { return headers; },
      http: async (request) => {
        urls.push(request.url);
        headers = request.headers;
        return jsonResponse(body, status);
      },
    };
  };

  it("maps the web envelope and sends the subscription token", async () => {
    const { http: h, urls } = http({ web: { results: [
      { title: "Result One", url: "https://one.test", description: "First." },
      { title: "No URL" },
      { title: "Bad scheme", url: "ftp://bad.test" },
    ] } });
    const results = await braveSearch(h, "  key-123  ", "query", 5);
    expect(results).toEqual([{ title: "Result One", url: "https://one.test", snippet: "First." }]);
    expect(urls[0]).toContain("q=query&count=5");
  });

  it("sends the trimmed key and clamps the count", async () => {
    const { http: h, urls } = http({ web: { results: [] } });
    await braveSearch(h, "  key-123  ", "q", 99);
    expect(urls[0]).toContain("count=20");
  });

  it("throws actionable errors on auth failure, rate limit, and malformed JSON", async () => {
    await expect(braveSearch(http({}, 401).http, "k", "q", 5)).rejects.toThrow(/rejected the key/);
    await expect(braveSearch(http({}, 429).http, "k", "q", 5)).rejects.toThrow(/rate limit/i);
    const badJson: DiscoveryHttp = async () => ({ status: 200, headers: {}, body: "not json" });
    await expect(braveSearch(badJson, "k", "q", 5)).rejects.toThrow(/unreadable/);
  });
});

describe("formatSearchResults", () => {
  it("renders numbered citable hits and a clean empty state", () => {
    const text = formatSearchResults("q", [{ title: "T", url: "https://t.test", snippet: "S" }]);
    expect(text).toContain("1. T");
    expect(text).toContain("https://t.test");
    expect(formatSearchResults("q", [])).toBe("No web results for: q");
  });
});
