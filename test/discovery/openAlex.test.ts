import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DiscoveryAdapterError, type DiscoveryHttp } from "../../src/discovery/adapters/http";
import { OpenAlexAdapter } from "../../src/discovery/adapters/openAlex";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/discovery/${name}`, import.meta.url)), "utf8");
const response = (body: string, status = 200, headers: Record<string, string> = {}) => ({ status, headers, body });

describe("OpenAlexAdapter", () => {
  it("maps search results without leaking raw payloads", async () => {
    let requestedUrl = "";
    const http: DiscoveryHttp = async ({ url }) => { requestedUrl = url; return response(fixture("openalex-search.json")); };
    const page = await new OpenAlexAdapter(http, { maxResults: 20, contact: "research@example.org" }).search({ text: "risk intervention", projectPath: "P.md" });
    expect(page.items[0]).toMatchObject({ adapter: "openalex", externalId: "W123", openAlexId: "W123", doi: "10.1/x", title: "Risk intervention", abstract: "An abstract about risk." });
    expect(page.items[0]?.authors).toEqual(["Ada Researcher"]);
    expect(page.items[0]?.referencedWorkIds).toEqual(["W100"]);
    expect(page.nextCursor).toBe("cursor-2");
    expect(requestedUrl).toContain("search=risk+intervention");
    expect(requestedUrl).toContain("mailto=research%40example.org");
    expect(JSON.stringify(page.items[0])).not.toContain("raw_secret");
  });

  it.each(["javascript:alert(1)", "file:///private/secret", "not a URL"])("omits unsafe result URLs: %s", async (unsafeUrl) => {
    const body = JSON.stringify({ results: [{ id: "https://openalex.org/W1", display_name: "Safe title", authorships: [], primary_location: { landing_page_url: unsafeUrl }, best_oa_location: { pdf_url: unsafeUrl } }], meta: {} });
    const page = await new OpenAlexAdapter(async () => response(body), { maxResults: 20 }).search({ text: "safe", projectPath: "P.md" });
    expect(page.items[0]).not.toHaveProperty("url");
    expect(page.items[0]).not.toHaveProperty("openAccessUrl");
  });

  it.each(["references", "cited-by"] as const)("maps one-hop %s expansion", async (direction) => {
    const requestedUrls: string[] = [];
    const http: DiscoveryHttp = async ({ url }) => {
      requestedUrls.push(url);
      return response(url.includes("/works/W123") ? fixture("openalex-work.json") : fixture("openalex-search.json"));
    };
    const page = await new OpenAlexAdapter(http, { maxResults: 20 }).expand({ seedOpenAlexId: "W123", direction, cursor: undefined });
    expect(page.items.every(({ adapter }) => adapter === "openalex")).toBe(true);
    expect(requestedUrls.at(-1)).toContain(direction === "references" ? "filter=openalex_id%3AW100" : "filter=cites%3AW123");
  });

  it("caps page size and forwards cursor and AbortSignal", async () => {
    const controller = new AbortController();
    let request: Parameters<DiscoveryHttp>[0] | undefined;
    const http: DiscoveryHttp = async (value) => { request = value; return response(fixture("openalex-search.json")); };
    await new OpenAlexAdapter(http, { maxResults: 500 }).search({ text: "risk", projectPath: "P.md" }, "next page", controller.signal);
    expect(request?.url).toContain("per-page=200");
    expect(request?.url).toContain("cursor=next+page");
    expect(request?.signal).toBe(controller.signal);
  });

  it.each([NaN, Infinity, -Infinity])("uses a bounded default for non-finite maxResults: %s", async (maxResults) => {
    let requestedUrl = "";
    const http: DiscoveryHttp = async ({ url }) => { requestedUrl = url; return response(fixture("openalex-search.json")); };
    await new OpenAlexAdapter(http, { maxResults }).search({ text: "risk", projectPath: "P.md" });
    expect(new URL(requestedUrl).searchParams.get("per-page")).toBe("20");
  });

  it("sanitizes rate-limit and malformed response failures", async () => {
    const limited = new OpenAlexAdapter(async () => response("private rate-limit body", 429, { "retry-after": "12" }), { maxResults: 20 });
    await expect(limited.search({ text: "risk", projectPath: "P.md" })).rejects.toMatchObject({ adapter: "openalex", category: "rate-limit", status: 429, retryAfterSeconds: 12 });
    const malformed = new OpenAlexAdapter(async () => response("private malformed json"), { maxResults: 20 });
    const error = await malformed.search({ text: "risk", projectPath: "P.md" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DiscoveryAdapterError);
    expect(String(error)).not.toContain("private malformed json");
  });
});
