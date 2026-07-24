import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DiscoveryHttp } from "../../src/discovery/adapters/http";
import { CrossrefAdapter } from "../../src/discovery/adapters/crossref";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/discovery/${name}`, import.meta.url)), "utf8");
const response = (body: string, status = 200) => ({ status, headers: {}, body });

describe("CrossrefAdapter", () => {
  it("maps an allowlisted DOI work and encodes its DOI path", async () => {
    let url = "";
    const http: DiscoveryHttp = async (request) => { url = request.url; return response(fixture("crossref-work.json")); };
    const work = await new CrossrefAdapter(http).lookupDoi("10.1/X");
    expect(work).toMatchObject({ adapter: "crossref", externalId: "10.1/x", doi: "10.1/x", title: "Risk intervention enriched", authors: ["Ada Researcher", "Research Group"], published: "2024-02-03", abstract: "Evidence & context." });
    expect(url).toContain("works/10.1%2FX");
    expect(JSON.stringify(work)).not.toContain("raw_secret");
  });

  it("returns undefined for a missing work and sanitizes malformed JSON", async () => {
    await expect(new CrossrefAdapter(async () => response("missing", 404)).lookupDoi("10.1/x")).resolves.toBeUndefined();
    const error = await new CrossrefAdapter(async () => response("private json")).lookupDoi("10.1/x").catch((value: unknown) => value);
    expect(String(error)).toContain("crossref");
    expect(String(error)).not.toContain("private json");
  });

  it("decodes entities once without turning nested encoded markup into tags", async () => {
    const payload = { message: { DOI: "10.1/nested", title: ["Nested"], abstract: "<jats:p>&amp;lt;script&amp;gt; &lt;safe&gt; &amp;amp;</jats:p>" } };
    const work = await new CrossrefAdapter(async () => response(JSON.stringify(payload))).lookupDoi("10.1/nested");
    expect(work?.abstract).toBe("&lt;script&gt; <safe> &amp;");
    expect(work?.abstract).not.toContain("<script>");
  });

  it.each([
    { message: null },
    { message: [] },
    { message: {} },
    { message: { DOI: "10.1/x" } },
    { message: { title: ["Missing DOI"] } },
  ])("rejects a successful envelope whose work identity is malformed: %j", async (payload) => {
    const adapter = new CrossrefAdapter(async () => response(JSON.stringify(payload)));
    await expect(adapter.lookupDoi("10.1/x")).rejects.toMatchObject({
      adapter: "crossref",
      category: "malformed-response",
    });
  });
});
