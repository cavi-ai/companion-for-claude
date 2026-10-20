import { describe, it, expect } from "vitest";
import { argumentError } from "../../src/mcp/arguments";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "number" },
    page: { type: "integer" },
    mode: { type: "string", enum: ["append", "prepend"] },
    tags: { type: "array" },
    meta: { type: "object" },
    done: { type: "boolean" },
    note: { type: ["string", "null"] },
  },
  required: ["path"],
};

describe("argumentError", () => {
  it("accepts arguments that match the schema", () => {
    expect(argumentError(schema, { path: "a.md", limit: 2.5, page: 3, mode: "append", tags: [], meta: {}, done: true, note: null, extra: 1 })).toBeNull();
  });

  it("names a missing required argument", () => {
    expect(argumentError(schema, {})).toBe("path is required");
  });

  it("names a wrong-typed argument and the types it accepts", () => {
    expect(argumentError(schema, { path: 12345 })).toBe("path must be a string");
    expect(argumentError(schema, { path: "a.md", limit: "3" })).toBe("limit must be a number");
    expect(argumentError(schema, { path: "a.md", page: 1.5 })).toBe("page must be an integer");
    expect(argumentError(schema, { path: "a.md", tags: {} })).toBe("tags must be an array");
    expect(argumentError(schema, { path: "a.md", meta: [] })).toBe("meta must be an object");
    expect(argumentError(schema, { path: "a.md", note: 1 })).toBe("note must be a string or null");
  });

  it("names an argument outside its enum", () => {
    expect(argumentError(schema, { path: "a.md", mode: "replace" })).toBe('mode must be one of "append", "prepend"');
  });

  it("refuses unknown arguments only when the schema forbids extras", () => {
    expect(argumentError({ ...schema, additionalProperties: false }, { path: "a.md", extra: 1 })).toBe("extra is not a known argument");
  });
});
