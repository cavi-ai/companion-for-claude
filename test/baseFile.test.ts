import { describe, it, expect } from "vitest";
import { buildBaseFile } from "../src/bases/baseFile";

describe("buildBaseFile", () => {
  it("emits the documented schema shape", () => {
    const yaml = buildBaseFile({
      filters: ['file.hasTag("book")'],
      formulas: { ppu: "(price / age).toFixed(2)" },
      properties: { status: "Status" },
      views: [
        {
          type: "table",
          name: "Reading list",
          order: ["file.name", "note.status", "formula.ppu"],
          groupBy: { property: "note.status", direction: "DESC" },
          limit: 50,
        },
      ],
    });
    expect(yaml).toBe(`filters:
  and:
    - "file.hasTag(\\"book\\")"
formulas:
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
views:
  - type: table
    name: Reading list
    groupBy:
      property: note.status
      direction: DESC
    order:
      - file.name
      - note.status
      - formula.ppu
    limit: 50
`);
  });

  it("defaults the view type to table and supports view-level filters", () => {
    const yaml = buildBaseFile({
      views: [{ name: "Open", filters: ['note.status == "open"'] }],
    });
    expect(yaml).toContain("- type: table");
    expect(yaml).toContain('- "note.status == \\"open\\""');
  });

  it("rejects invalid proposals", () => {
    expect(() => buildBaseFile({ views: [] })).toThrow(/at least one view/i);
    expect(() => buildBaseFile({ views: [{ name: " " }] })).toThrow(/name/i);
    expect(() => buildBaseFile({ views: [{ name: "v", limit: -1 }] })).toThrow(/positive/i);
    expect(() => buildBaseFile({ filters: [" "], views: [{ name: "v" }] })).toThrow(/non-empty/i);
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `v${i}` }));
    expect(() => buildBaseFile({ views: many })).toThrow(/too many/i);
  });

  it("quotes YAML-hostile scalars", () => {
    const yaml = buildBaseFile({ properties: { status: "Status: current" }, views: [{ name: "true" }] });
    expect(yaml).toContain('displayName: "Status: current"');
    expect(yaml).toContain('name: "true"');
  });

  it("accepts list and map view types and rejects unknown ones", () => {
    const yaml = buildBaseFile({
      views: [
        { type: "list", name: "Simple list" },
        { type: "map", name: "Locations" },
      ],
    });
    expect(yaml).toContain("- type: list");
    expect(yaml).toContain("- type: map");
    expect(() => buildBaseFile({ views: [{ type: "kanban", name: "v" }] })).toThrow(/table, cards, list, map/i);
  });

  it("emits recursive and/or/not filter groups", () => {
    const yaml = buildBaseFile({
      filters: {
        and: [
          'status == "active"',
          { not: ['file.hasTag("archived")'] },
          { or: ['file.hasTag("book")', 'file.hasTag("article")'] },
        ],
      },
      views: [{ name: "v" }],
    });
    expect(yaml).toBe(`filters:
  and:
    - "status == \\"active\\""
    - not:
        - "file.hasTag(\\"archived\\")"
    - or:
        - "file.hasTag(\\"book\\")"
        - "file.hasTag(\\"article\\")"
views:
  - type: table
    name: v
`);
  });

  it("emits a single filter statement inline", () => {
    const yaml = buildBaseFile({
      filters: 'status == "done"',
      views: [{ name: "v", filters: 'note.priority > 3' }],
    });
    expect(yaml).toContain('filters: "status == \\"done\\""');
    expect(yaml).toContain('    filters: "note.priority > 3"');
  });

  it("supports recursive filters at the view level", () => {
    const yaml = buildBaseFile({
      views: [{ name: "v", filters: { or: ['a == 1', { not: ["b == 2"] }] } }],
    });
    expect(yaml).toContain(`    filters:
      or:
        - "a == 1"
        - not:
            - "b == 2"`);
  });

  it("rejects malformed filter groups", () => {
    expect(() => buildBaseFile({ filters: { and: [] }, views: [{ name: "v" }] })).toThrow(/at least one/i);
    expect(() => buildBaseFile({ filters: { nand: ["x"] } as never, views: [{ name: "v" }] })).toThrow(/and, or, not/i);
    expect(() => buildBaseFile({ filters: { and: ["x"], or: ["y"] } as never, views: [{ name: "v" }] })).toThrow(/exactly one/i);
    expect(() => buildBaseFile({ filters: { and: [" "] }, views: [{ name: "v" }] })).toThrow(/non-empty/i);
  });

  it("emits per-view summaries validated against built-ins and custom summaries", () => {
    const yaml = buildBaseFile({
      summaries: { p90: "values.percentile(90)" },
      views: [
        {
          name: "Costs",
          order: ["file.name", "note.price"],
          summaries: { "note.price": "Sum", "note.age": "p90" },
        },
      ],
    });
    expect(yaml).toContain(`summaries:
  p90: values.percentile(90)`);
    expect(yaml).toContain(`    summaries:
      note.price: Sum
      note.age: p90`);
    expect(() =>
      buildBaseFile({ views: [{ name: "v", summaries: { price: "Total" } }] })
    ).toThrow(/unknown summary/i);
  });
});
