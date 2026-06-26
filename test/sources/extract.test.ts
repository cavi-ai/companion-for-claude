import { describe, it, expect } from "vitest";
import { extractFields, ExtractError } from "../../src/sources/extract";
import { getSchema } from "../../src/sources/registry";

const article = getSchema("article");

describe("extractFields", () => {
  it("merges model fields with derived fields", async () => {
    const complete = async () => JSON.stringify({ title: "T", site: "S", summary: "Sum" });
    const r = await extractFields(article, "content", { reading_time: "9 min" }, { complete });
    expect(r.fields.title).toBe("T");
    expect(r.fields.reading_time).toBe("9 min");
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
});
