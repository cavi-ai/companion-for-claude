import { describe, expect, it } from "vitest";
import { parseCsv, renderDatasetExplorer } from "../../src/living/datasetExplorer";

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, newlines inside quotes, CRLF and a BOM", () => {
    const csv = '﻿name,note\r\n"Smith, J","said ""hi"""\r\nLee,"two\nlines"\r\n\r\n';
    expect(parseCsv(csv)).toEqual({ columns: ["name", "note"], rows: [["Smith, J", 'said "hi"'], ["Lee", "two\nlines"]], total: 2 });
  });

  it("pads short rows, caps embedded rows, and counts every data row", () => {
    const csv = ["a,b", "1", ...Array.from({ length: 9 }, (_, i) => `${i},${i}`)].join("\n");
    const table = parseCsv(csv, 3)!;
    expect(table.rows).toEqual([["1", ""], ["0", "0"], ["1", "1"]]);
    expect(table.total).toBe(10);
  });

  it("returns null without a header row", () => {
    expect(parseCsv("")).toBeNull();
    expect(parseCsv("\n,,\n\n")).toBeNull();
  });
});

describe("dataset explorer page", () => {
  it("embeds the table as JSON that cannot close its script tag or the note's code fence", () => {
    const html = renderDatasetExplorer({ columns: ["item", "note"], rows: [["</script><b>x</b>", "```fence```"]], total: 1 }, { title: "Prices", asset: "Data/prices.csv" });
    const data = /<script type="application\/json" id="lv-data">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(data)).toEqual({ columns: ["item", "note"], rows: [["</script><b>x</b>", "```fence```"]], total: 1 });
    expect(html).not.toContain("```");
    expect(html).toContain("Data/prices.csv · 2 columns · 1 row<");
  });
});
