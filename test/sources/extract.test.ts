import { describe, it, expect } from "vitest";
import { extractFields, ExtractError, extractionJsonSchema, type ExtractCompletionOpts } from "../../src/sources/extract";
import { getSchema } from "../../src/sources/registry";

const article = getSchema("article");

describe("extractFields", () => {
  it("merges model fields with derived fields", async () => {
    const complete = async () => JSON.stringify({ title: "T", site: "S", summary: "Sum" });
    const r = await extractFields(article, "content", { reading_time: "9 min" }, { complete });
    expect(r.fields.title).toBe("T");
    expect(r.fields.reading_time).toBe("9 min");
  });

  it("asks for constrained JSON output with thinking disabled and room to answer", async () => {
    const seen: ExtractCompletionOpts[] = [];
    const complete = async (_s: string, _u: string, opts?: ExtractCompletionOpts) => {
      seen.push(opts ?? {});
      return JSON.stringify({ title: "T", site: "S", summary: "Sum" });
    };
    await extractFields(article, "content", {}, { complete });
    const opts = seen[0]!;
    // Thinking models spend the whole budget on hidden reasoning and reply
    // empty ("reply was not valid JSON") — extraction must disable it.
    expect(opts.disableThinking).toBe(true);
    expect(opts.maxTokens).toBeGreaterThan(1024);
    const schema = opts.responseSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(article.fields.filter((f) => f.source === "model").map((f) => f.key));
    expect(schema.required).toEqual(["title", "site", "summary"]);
  });

  it("repairs after an invalid first reply", async () => {
    let n = 0;
    const complete = async () => (n++ === 0 ? "garbage, no json" : JSON.stringify({ title: "T", site: "S", summary: "Sum" }));
    const r = await extractFields(article, "content", {}, { complete }, 2);
    expect(r.fields.title).toBe("T");
    expect(n).toBe(2);
  });

  it("throws ExtractError when required fields never arrive", async () => {
    const complete = async () => JSON.stringify({ title: "T" });
    await expect(extractFields(article, "content", {}, { complete }, 1)).rejects.toBeInstanceOf(ExtractError);
  });

  it("does not ask the model for prefilled fields, and merges them into the result", async () => {
    let system = "";
    const complete = async (sys: string) => {
      system = sys;
      // The reply only carries what it was asked for; required title/site are prefilled.
      return JSON.stringify({ summary: "Sum" });
    };
    const r = await extractFields(article, "content", {}, { complete }, 2, { title: "Clip title", site: "Clip site" });
    expect(system).not.toContain("- title (");
    expect(system).not.toContain("- site (");
    expect(system).toContain("- summary (");
    expect(r.fields).toMatchObject({ title: "Clip title", site: "Clip site", summary: "Sum" });
  });

  it("skips the model call entirely when every model field is prefilled", async () => {
    let calls = 0;
    const complete = async () => {
      calls++;
      return "{}";
    };
    const r = await extractFields(article, "content", { reading_time: "9 min" }, { complete }, 2, {
      title: "T",
      author: "A",
      authors: ["A"],
      site: "S",
      publication: "P",
      published: "2026-01-01",
      doi: "10.1/x",
      arxiv_id: "1234.5678",
      zotero_key: "ZK",
      reading_time: "5 min",
      topics: ["x"],
      key_claims: ["c"],      summary: "S",
    });
    expect(calls).toBe(0);
    expect(r.fields.reading_time).toBe("9 min"); // derived still wins over prefilled
    expect(r.fields.title).toBe("T");
  });
});

describe("extractionJsonSchema", () => {
  it("maps field types to nullable JSON Schema with the required keys", () => {
    const schema = extractionJsonSchema(article.fields.filter((f) => f.source === "model"));
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        title: { type: ["string", "null"] },
        authors: { type: ["array", "null"], items: { type: "string" } },
      },
      required: ["title", "site", "summary"],
    });
  });
});
