import { describe, it, expect } from "vitest";
import { formatTagList } from "../../src/tags/label";

describe("formatTagList", () => {
  it("marks only tags that are new to the vault", () => {
    expect(formatTagList(["llm", "brand-new", "rust"], ["brand-new"])).toBe("llm, brand-new (new), rust");
  });
  it("is a plain join when nothing is new", () => {
    expect(formatTagList(["a", "b"], [])).toBe("a, b");
    expect(formatTagList([], ["x"])).toBe("");
  });
});
