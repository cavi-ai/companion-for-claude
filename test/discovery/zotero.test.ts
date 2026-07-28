import { describe, expect, it } from "vitest";
import type { DiscoveryHttp, DiscoveryHttpRequest } from "../../src/discovery/adapters/http";
import { ZoteroAdapter, type ZoteroLibrary } from "../../src/discovery/adapters/zotero";

const response = (body: string, status = 200) => ({ status, headers: {}, body });

const LIBRARY: ZoteroLibrary = { userId: "12345678", apiKey: "secret-key" };

function capture(body: string, status = 200): { http: DiscoveryHttp; requests: DiscoveryHttpRequest[] } {
  const requests: DiscoveryHttpRequest[] = [];
  return {
    requests,
    http: async (request) => {
      requests.push(request);
      return response(body, status);
    },
  };
}

const journalItem = {
  key: "ABCD2345",
  data: {
    itemType: "journalArticle",
    title: "Evidence Synthesis at Scale",
    creators: [
      { creatorType: "author", firstName: "Ada", lastName: "Researcher" },
      { creatorType: "author", name: "Research Group" },
    ],
    date: "2024-02-03",
    publicationTitle: "Journal of Tests",
    DOI: "10.1/XYZ",
    url: "https://example.test/article",
    abstractNote: "An abstract.",
  },
};

describe("ZoteroAdapter", () => {
  it("maps a journal article item and sends the API headers", async () => {
    const { http, requests } = capture(JSON.stringify(journalItem));
    const work = await new ZoteroAdapter(http, () => LIBRARY).lookup("ABCD2345");
    expect(work).toEqual({
      adapter: "zotero",
      externalId: "ABCD2345",
      zoteroKey: "ABCD2345",
      title: "Evidence Synthesis at Scale",
      authors: ["Ada Researcher", "Research Group"],
      doi: "10.1/xyz",
      published: "2024-02-03",
      publication: "Journal of Tests",
      abstract: "An abstract.",
      url: "https://example.test/article",
    });
    expect(requests[0]?.url).toBe("https://api.zotero.org/users/12345678/items/ABCD2345");
    expect(requests[0]?.headers).toEqual({ "Zotero-API-Version": "3", "Zotero-API-Key": "secret-key" });
  });

  it("omits the API key header for a public library and falls back across publication fields", async () => {
    const item = { key: "BOOK1234", data: { itemType: "bookSection", title: "A Chapter", creators: [], date: "March 2021", bookTitle: "The Book" } };
    const { http, requests } = capture(JSON.stringify(item));
    const work = await new ZoteroAdapter(http, () => ({ userId: "12345678" })).lookup("BOOK1234");
    expect(work).toMatchObject({ title: "A Chapter", authors: [], published: "2021", publication: "The Book" });
    expect(requests[0]?.headers).toEqual({ "Zotero-API-Version": "3" });
  });

  it("returns undefined for a missing item, a non-source item, an invalid key, or no library", async () => {
    const { http, requests } = capture("missing", 404);
    const adapter = new ZoteroAdapter(http, () => LIBRARY);
    await expect(adapter.lookup("ABCD2345")).resolves.toBeUndefined();

    const attachment = { key: "ATT99999", data: { itemType: "attachment", title: "fulltext.pdf" } };
    await expect(new ZoteroAdapter(async () => response(JSON.stringify(attachment)), () => LIBRARY).lookup("ATT99999")).resolves.toBeUndefined();

    const before = requests.length;
    await expect(adapter.lookup("../etc/passwd")).resolves.toBeUndefined();
    await expect(new ZoteroAdapter(http, () => undefined).lookup("ABCD2345")).resolves.toBeUndefined();
    await expect(new ZoteroAdapter(http, () => ({ userId: "not-a-user-id" })).lookup("ABCD2345")).resolves.toBeUndefined();
    expect(requests.length).toBe(before); // no request without a valid key + library
  });

  it("sanitizes malformed responses without leaking the body", async () => {
    const error = await new ZoteroAdapter(async () => response("private json"), () => LIBRARY).lookup("ABCD2345").catch((value: unknown) => value);
    expect(String(error)).toContain("zotero");
    expect(String(error)).not.toContain("private json");

    const noTitle = { key: "ABCD2345", data: { itemType: "journalArticle" } };
    await expect(new ZoteroAdapter(async () => response(JSON.stringify(noTitle)), () => LIBRARY).lookup("ABCD2345")).rejects.toThrow(/zotero/);
  });

  it("rejects non-2xx statuses through the shared error taxonomy", async () => {
    await expect(new ZoteroAdapter(async () => response("rate limited", 429), () => LIBRARY).lookup("ABCD2345")).rejects.toThrow(/rate-limit/);
    await expect(new ZoteroAdapter(async () => response("forbidden", 403), () => LIBRARY).lookup("ABCD2345")).rejects.toThrow(/http/);
  });
});
