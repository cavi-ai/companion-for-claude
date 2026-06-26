import { describe, it, expect } from "vitest";
import { getSchema } from "../../src/sources/registry";

describe("getSchema", () => {
  it("returns the built-in article schema with a required title + summary", () => {
    const s = getSchema("article");
    expect(s.type).toBe("article");
    const byKey = Object.fromEntries(s.fields.map((f) => [f.key, f]));
    expect(byKey.title.required).toBe(true);
    expect(byKey.summary.required).toBe(true);
  });

  it("marks dataset columns + rows as derived", () => {
    const s = getSchema("dataset");
    const byKey = Object.fromEntries(s.fields.map((f) => [f.key, f]));
    expect(byKey.columns.source).toBe("derived");
    expect(byKey.rows.source).toBe("derived");
  });

  it("deep-merges a user override onto a matching field by key", () => {
    const s = getSchema("article", { article: { fields: [{ key: "title", type: "string", required: false, source: "model", description: "x" }] } });
    const title = s.fields.find((f) => f.key === "title")!;
    expect(title.required).toBe(false);
    expect(s.fields.filter((f) => f.key === "title")).toHaveLength(1);
  });

  it("appends an override field that does not exist in the built-in", () => {
    const s = getSchema("article", { article: { fields: [{ key: "paywalled", type: "string", required: false, source: "model", description: "x" }] } });
    expect(s.fields.some((f) => f.key === "paywalled")).toBe(true);
  });
});
