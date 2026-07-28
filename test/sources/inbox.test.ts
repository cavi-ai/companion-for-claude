import { describe, it, expect } from "vitest";
import { inboxItems, type InboxFileEntry } from "../../src/sources/inbox";

const entry = (path: string, frontmatter?: Record<string, unknown>): InboxFileEntry => {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return { path, basename: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot + 1) : "", frontmatter };
};

describe("inboxItems", () => {
  it("lists unenriched markdown clips with a detected type", () => {
    const items = inboxItems(
      [
        entry("Clippings/a.md", { source: "https://example.com/p" }),
        entry("Clippings/v.md", { source: "https://www.youtube.com/watch?v=1" }),
        entry("Clippings/t.md", { type: "video", source: "https://example.com/other" }),
      ],
      "Clippings",
    );
    expect(items.map((i) => [i.basename, i.type])).toEqual([
      ["a", "article"],
      ["t", "video"], // stamped type beats the URL
      ["v", "video"],
    ]);
  });

  it("skips enriched markdown notes", () => {
    const items = inboxItems([entry("Clippings/a.md", { source_enriched: true }), entry("Clippings/b.md", {})], "Clippings");
    expect(items.map((i) => i.basename)).toEqual(["b"]);
  });

  it("treats a csv as pending until its sidecar exists", () => {
    const entries = [entry("Clippings/sales.csv"), entry("Clippings/sales-note.md", { source_enriched: true, asset: "Clippings/sales.csv" })];
    expect(inboxItems(entries, "Clippings")).toEqual([]);
    expect(inboxItems([entry("Clippings/sales.csv")], "Clippings").map((i) => i.type)).toEqual(["dataset"]);
  });

  it("ignores files outside the inbox and unsupported extensions", () => {
    const items = inboxItems(
      [entry("Notes/a.md"), entry("Clippings/img.png"), entry("Clippings/a.md")],
      "Clippings",
    );
    expect(items.map((i) => i.path)).toEqual(["Clippings/a.md"]);
  });

  it("handles a trailing slash and an empty inbox setting", () => {
    expect(inboxItems([entry("Clippings/a.md")], "Clippings/").map((i) => i.basename)).toEqual(["a"]);
    expect(inboxItems([entry("a.md")], "")).toEqual([]);
  });

  it("treats missing frontmatter as a pending article", () => {
    expect(inboxItems([entry("Clippings/raw.md")], "Clippings").map((i) => i.type)).toEqual(["article"]);
  });
});
