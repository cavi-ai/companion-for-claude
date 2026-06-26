import { describe, it, expect } from "vitest";
import { extractJson, validateAgainstSchema } from "../../src/sources/validate";
import { getSchema } from "../../src/sources/registry";

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses a fenced json block with prose around it", () => {
    expect(extractJson('Here:\n```json\n{"a":"b"}\n```\nthanks')).toEqual({ a: "b" });
  });
  it("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("validateAgainstSchema", () => {
  const article = getSchema("article");
  it("accepts a valid object and coerces a string[] field", () => {
    const r = validateAgainstSchema({ title: "T", site: "S", summary: "Sum", topics: ["a", "b"] }, article);
    expect(r.ok).toBe(true);
    expect(r.value.topics).toEqual(["a", "b"]);
  });
  it("errors when a required field is missing", () => {
    const r = validateAgainstSchema({ title: "T", site: "S" }, article);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/summary/);
  });
  it("drops a malformed optional field instead of failing", () => {
    const r = validateAgainstSchema({ title: "T", site: "S", summary: "Sum", topics: "not-an-array" }, article);
    expect(r.ok).toBe(true);
    expect(r.value.topics).toBeUndefined();
  });
  it("only considers model-sourced fields (ignores derived)", () => {
    const dataset = getSchema("dataset");
    const r = validateAgainstSchema({ title: "T", summary: "S" }, dataset);
    expect(r.ok).toBe(true);
    expect(r.value.columns).toBeUndefined();
  });
});
