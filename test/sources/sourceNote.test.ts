import { describe, it, expect, vi } from "vitest";
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

  it("resolves topics into tags but never the base tags, and leaves topics raw", () => {
    const withTopics: SourceRecord = { ...record, fields: { ...record.fields, topics: ["LLMs", "New Thing"] } };
    const seen: string[][] = [];
    const fm = sourceFrontmatter(withTopics, ["source", "llms"], (tags) => {
      seen.push(tags);
      return tags.map((t) => (t === "LLMs" ? "llm" : t.toLowerCase()));
    });
    expect(seen).toEqual([["LLMs", "New Thing"]]);
    expect(fm.tags).toEqual(["source", "llms", "llm", "new-thing"]);
    expect(fm.topics).toEqual(["LLMs", "New Thing"]);
  });

  it("does not call the resolver for a record without topics", () => {
    const resolve = vi.fn((tags: string[]) => tags);
    const fm = sourceFrontmatter(record, ["source"], resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(fm.tags).toEqual(["source"]);
  });
});
