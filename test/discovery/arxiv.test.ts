import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DiscoveryHttp } from "../../src/discovery/adapters/http";
import { ArxivAdapter } from "../../src/discovery/adapters/arxiv";
import { TestDOMParser } from "./xmlDom";

Object.assign(globalThis, { DOMParser: TestDOMParser });

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/discovery/${name}`, import.meta.url)), "utf8");
const response = (body: string, status = 200) => ({ status, headers: {}, body });

describe("ArxivAdapter", () => {
  it("normalizes a versioned lookup while retaining the public external ID", async () => {
    let request: Parameters<DiscoveryHttp>[0] | undefined;
    const http: DiscoveryHttp = async (value) => { request = value; return response(fixture("arxiv-feed.xml")); };
    const controller = new AbortController();
    const work = await new ArxivAdapter(http).lookup("2401.01234v9", controller.signal);
    expect(request?.url).toContain("id_list=2401.01234");
    expect(request?.signal).toBe(controller.signal);
    expect(work).toMatchObject({ adapter: "arxiv", externalId: "2401.01234v2", arxivId: "2401.01234v2", doi: "10.1/x", title: "A scholarly preprint", authors: ["Ada Researcher", "Bob Scholar"], published: "2024-01-03", abstract: "Useful findings with context." });
    expect(JSON.stringify(work)).not.toContain("raw_secret");
  });

  it("returns undefined for an empty feed and rejects malformed or unidentified XML safely", async () => {
    await expect(new ArxivAdapter(async () => response("<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\" />")).lookup("2401.01234")).resolves.toBeUndefined();
    for (const body of ["not xml", "<feed><entry><title>No identity</title></entry></feed>"]) {
      const error = await new ArxivAdapter(async () => response(body)).lookup("2401.01234").catch((value: unknown) => value);
      expect(String(error)).toContain("arxiv");
      expect(String(error)).not.toContain(body);
    }
  });

  it.each(["javascript:alert(1)", "file:///private/secret", "not a URL"])("omits unsafe feed URLs: %s", async (unsafeUrl) => {
    const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2401.1</id><title>Safe</title><link rel="alternate" href="${unsafeUrl}"/><link title="pdf" href="${unsafeUrl}"/></entry></feed>`;
    const work = await new ArxivAdapter(async () => response(body)).lookup("2401.1");
    expect(work).not.toHaveProperty("url");
    expect(work).not.toHaveProperty("openAccessUrl");
  });

  it("decodes XML entities once without recursively unescaping nested text", async () => {
    const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2401.1</id><title>&amp;lt;script&amp;gt; &lt;safe&gt;</title></entry></feed>`;
    const work = await new ArxivAdapter(async () => response(body)).lookup("2401.1");
    expect(work?.title).toBe("&lt;script&gt; <safe>");
    expect(work?.title).not.toContain("<script>");
  });
});
