import { describe, expect, it } from "vitest";
import { verifyClipperNote } from "../../src/sources/clipperVerification";

const expected = {
  type: "article" as const,
  schemaVersion: 1,
  destination: "Clippings",
  fingerprint: "abc123",
  baseTags: ["source"],
};

describe("verifyClipperNote", () => {
  it("verifies a matching first clip with supported provenance", () => {
    expect(verifyClipperNote({
      path: "Clippings/Test.md",
      frontmatter: { type: "article", schema_version: 1, source: "https://example.com", tags: ["source", "research"] },
    }, expected)).toMatchObject({ state: "verified", path: "Clippings/Test.md", mismatches: [] });
  });

  it("reports the observed path when Clipper writes to the wrong destination", () => {
    expect(verifyClipperNote({
      path: "Notes/Test.md",
      frontmatter: { type: "article", schema_version: 1, source: "https://example.com" },
    }, expected)).toMatchObject({ state: "wrong-destination", path: "Notes/Test.md" });
  });

  it("returns bounded field-specific mismatches for stale or malformed clips", () => {
    const result = verifyClipperNote({
      path: "Clippings/Test.md",
      frontmatter: { type: "video", schema_version: 0, source: "javascript:alert(1)", tags: [] },
    }, expected);
    expect(result.state).toBe("needs-attention");
    expect(result.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "type" }),
      expect.objectContaining({ field: "schema_version" }),
      expect.objectContaining({ field: "source" }),
      expect.objectContaining({ field: "tags" }),
    ]));
    expect(result.mismatches.length).toBeLessThanOrEqual(12);
  });

  it("accepts the legacy url provenance field", () => {
    expect(verifyClipperNote({
      path: "Clippings/Legacy.md",
      frontmatter: { type: "article", schema_version: "1", url: "https://example.com/legacy", tags: "source" },
    }, expected).state).toBe("verified");
  });
});
