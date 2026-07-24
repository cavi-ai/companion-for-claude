import { describe, it, expect } from "vitest";
import { sourceFrontmatter, buildSidecarNote } from "../../src/sources/sourceNote";
import type { SourceRecord } from "../../src/sources/types";

const record: SourceRecord = {
  type: "dataset",
  fields: { title: "US home sales", columns: ["date", "units"], rows: 1204, summary: "Monthly sales." },
  provenance: { capturedAt: "2026-06-16T00:00:00Z", schemaVersion: 1, enrichedBy: "claude", assetPath: "Clippings/sales.csv" },
};

describe("sourceFrontmatter", () => {
  it("flattens type, fields, marker, and provenance", () => {
    const fm = sourceFrontmatter(record, ["source"]);
    expect(fm.type).toBe("dataset");
    expect(fm.title).toBe("US home sales");
    expect(fm.source_enriched).toBe(true);
    expect(fm.schema_version).toBe(1);
    expect(fm.captured_at).toBe("2026-06-16T00:00:00Z");
    expect(fm.tags).toEqual(["source"]);
  });

  it("includes the url for a record that has one", () => {
    const fm = sourceFrontmatter(
      { type: "article", fields: { title: "T", site: "S", summary: "x" }, provenance: { url: "https://x.com/p", capturedAt: "2026-06-16T00:00:00Z", schemaVersion: 1, enrichedBy: "claude" } },
      ["source"],
    );
    expect(fm.url).toBe("https://x.com/p");
  });
});

describe("buildSidecarNote", () => {
  it("embeds the asset and uses the title heading", () => {
    const md = buildSidecarNote(record, "sales.csv", ["source"]);
    expect(md).toContain('type: "dataset"');
    expect(md).toContain("source_enriched: true");
    expect(md).toContain("# US home sales");
    expect(md).toContain("Monthly sales.");
    expect(md).toContain("![[sales.csv]]");
  });
});
