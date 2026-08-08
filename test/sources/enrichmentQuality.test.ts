import { describe, expect, it } from "vitest";
import {
  EnrichmentQualityError,
  assertBodyPreserved,
  markdownBody,
  validateEnrichment,
} from "../../src/sources/enrichmentQuality";
import type { SourceRecord, SourceTypeSchema } from "../../src/sources/types";
import { getSchema } from "../../src/sources/registry";

function article(fields: Record<string, unknown> = {}): SourceRecord {
  return {
    type: "article",
    fields: {
      title: "A meaningful article title",
      site: "Example",
      summary: "A concise account of the source.",
      ...fields,
    },
    provenance: {
      capturedAt: "2026-08-08T00:00:00Z",
      schemaVersion: 1,
      enrichedBy: "claude",
    },
  } as SourceRecord;
}

function qualityErrors(
  record: SourceRecord,
  schema: SourceTypeSchema = getSchema(record.type),
  captureBasename?: string,
): string[] {
  try {
    validateEnrichment(record, schema, { captureBasename });
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(EnrichmentQualityError);
    return (error as EnrichmentQualityError).errors;
  }
}

describe("validateEnrichment", () => {
  it("accepts a valid record with a 200-character summary boundary", () => {
    expect(() => validateEnrichment(article({ summary: "s".repeat(200), topics: ["local-ai", "research"] }), getSchema("article"))).not.toThrow();
  });

  it.each(["", "   ", "Untitled", "untitled document"])("rejects blank or placeholder title %j", (title) => {
    expect(qualityErrors(article({ title }))).toContain("title: must be a meaningful, non-placeholder title");
  });

  it.each(["Untitled.", "No title!"])("rejects a punctuation-decorated placeholder title %j", (title) => {
    expect(qualityErrors(article({ title }))).toContain("title: must be a meaningful, non-placeholder title");
  });

  it.each(["Article", "Source"])("accepts the legitimate descriptive title %j", (title) => {
    expect(() => validateEnrichment(article({ title }), getSchema("article"), { captureBasename: title.toLowerCase() })).not.toThrow();
  });

  it.each([
    ["document.md", "document"],
    ["article.pdf", "article"],
    ["capture.txt", "capture"],
    ["No title.md", "No title"],
    ["Unknown title.pdf", "Unknown title"],
    ["Untitled document.md", "Untitled document"],
    ["#article.pdf", "article"],
    ["article.pdf!", "article"],
  ])("rejects filename-derived placeholder title %j", (title, captureBasename) => {
    expect(qualityErrors(article({ title }), getSchema("article"), captureBasename)).toContain(
      "title: must be a meaningful, non-placeholder title",
    );
  });

  it("rejects a blank summary", () => {
    expect(qualityErrors(article({ summary: " \n\t " }))).toContain("summary: must be a non-empty string");
  });

  it("rejects a summary over 200 characters", () => {
    expect(qualityErrors(article({ summary: "s".repeat(201) }))).toContain("summary: must be at most 200 characters");
  });

  it("reports each field whose runtime value has an invalid type", () => {
    const errors = qualityErrors(article({ topics: ["research", 42], rows: Number.POSITIVE_INFINITY, metadata: { private: true } }));
    expect(errors).toEqual([
      "fields.topics: expected string[]",
      "fields.rows: not declared by article schema",
      "fields.metadata: not declared by article schema",
    ]);
  });

  it("rejects a missing required article site", () => {
    const record = article();
    delete record.fields.site;
    expect(qualityErrors(record)).toContain("fields.site: missing required field");
  });

  it("rejects an article site with the wrong schema type", () => {
    expect(qualityErrors(article({ site: 42 }))).toContain("fields.site: expected string");
  });

  it("rejects fields not declared by the resolved schema", () => {
    expect(qualityErrors(article({ extra: "not declared" }))).toContain("fields.extra: not declared by article schema");
  });

  it("uses a dataset override when validating a derived rows field", () => {
    const schema = getSchema("dataset", {
      dataset: {
        fields: [{ key: "rows", type: "string", required: false, source: "derived", description: "row count label" }],
      },
    });
    const record: SourceRecord = {
      type: "dataset",
      fields: { title: "Sales by month", summary: "Monthly sales totals.", rows: 12 },
      provenance: { capturedAt: "2026-08-08T00:00:00Z", schemaVersion: 1, enrichedBy: "claude", assetPath: "Clippings/sales.csv" },
    };
    expect(qualityErrors(record, schema)).toContain("fields.rows: expected string");
  });

  it("rejects sanitized and raw secret-bearing field values", () => {
    const errors = qualityErrors(article({ summary: "Credentials: ‹REDACTED›", topics: ["safe", "ghp_abcdefghijklmnopqrstuvwxyz0123"] }));
    expect(errors).toEqual([
      "fields.summary: contains secret-bearing content",
      "fields.topics[1]: contains secret-bearing content",
    ]);
  });

  it("rejects secret-bearing URL and asset provenance", () => {
    const record = article();
    record.provenance.url = "https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz0123";
    record.provenance.assetPath = "Clippings/API_KEY=abcdef123.csv";
    expect(qualityErrors(record)).toEqual([
      "provenance.url: contains secret-bearing content",
      "provenance.assetPath: contains secret-bearing content",
    ]);
  });
});

describe("markdown body preservation", () => {
  it("removes only a leading YAML block and retains every following byte", () => {
    const content = "---\r\ntitle: Before\r\n---\r\n\r\n# Heading\r\n\r\n---\r\nBody  \r\n";
    expect(markdownBody(content)).toBe("\r\n# Heading\r\n\r\n---\r\nBody  \r\n");
  });

  it("returns the complete content when there is no leading YAML block", () => {
    const content = "# Heading\n\n---\nBody\n";
    expect(markdownBody(content)).toBe(content);
  });

  it("throws a quality error when any body byte changes", () => {
    const before = "---\ntitle: Before\n---\n\nBody  \n";
    const after = "---\ntitle: After\n---\n\nBody\n";
    expect(() => assertBodyPreserved(before, after)).toThrowError(
      new EnrichmentQualityError(["markdown body changed during enrichment"]),
    );
  });

  it("accepts changed frontmatter when the body bytes are identical", () => {
    const before = "---\ntitle: Before\n---\n\nBody  \n";
    const after = "---\ntitle: After\ntags: [source]\n---\n\nBody  \n";
    expect(() => assertBodyPreserved(before, after)).not.toThrow();
  });

  it("does not treat the closing YAML delimiter's line ending as a body byte", () => {
    const before = "---\r\ntitle: Before\r\n---\r\nBody bytes\r\n";
    const after = "---\ntitle: After\n---\nBody bytes\r\n";
    expect(() => assertBodyPreserved(before, after)).not.toThrow();
  });
});
