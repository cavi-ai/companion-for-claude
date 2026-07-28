import { describe, it, expect } from "vitest";
import { wireUpItems, type WireUpEntry } from "../../src/links/wireUp";
import type { LinkCandidate } from "../../src/links/unlinkedMentions";

const CANDIDATES: LinkCandidate[] = [
  { path: "Notes/Knowledge graphs.md", basename: "Knowledge graphs", aliases: [] },
  { path: "Notes/Companion.md", basename: "Companion", aliases: ["CC"] },
];

const entry = (path: string, content: string, frontmatter?: Record<string, unknown>): WireUpEntry => {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return { path, basename: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot + 1) : "", frontmatter, content };
};

describe("wireUpItems", () => {
  it("lists enriched inbox notes with unlinked mentions, most-linked first", () => {
    const items = wireUpItems(
      [
        entry("Clippings/a.md", "All about Knowledge graphs today.", { source_enriched: true }),
        entry("Clippings/b.md", "Knowledge graphs and Companion together.", { source_enriched: true }),
      ],
      CANDIDATES,
      "Clippings",
    );
    expect(items.map((i) => [i.basename, i.mentionCount])).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("skips unenriched notes, notes outside the inbox, and fully-linked prose", () => {
    const items = wireUpItems(
      [
        entry("Clippings/raw.md", "Knowledge graphs.", {}),
        entry("Notes/c.md", "Knowledge graphs.", { source_enriched: true }),
        entry("Clippings/linked.md", "See [[Knowledge graphs]].", { source_enriched: true }),
      ],
      CANDIDATES,
      "Clippings",
    );
    expect(items).toEqual([]);
  });

  it("skips data files and never counts self-mentions", () => {
    const items = wireUpItems(
      [
        entry("Clippings/data.csv", "Knowledge graphs", { source_enriched: true }),
        // Only the note itself is a candidate — self-mentions must not count.
        entry("Clippings/Companion.md", "Companion is great. Companion!", { source_enriched: true }),
      ],
      [{ path: "Clippings/Companion.md", basename: "Companion", aliases: [] }],
      "Clippings",
    );
    expect(items).toEqual([]);
  });

  it("counts a mention of a different note that shares the name", () => {
    const items = wireUpItems(
      [entry("Clippings/Companion.md", "Companion is great.", { source_enriched: true })],
      [
        { path: "Clippings/Companion.md", basename: "Companion", aliases: [] },
        { path: "Notes/Companion.md", basename: "Companion", aliases: [] },
      ],
      "Clippings",
    );
    expect(items).toEqual([{ path: "Clippings/Companion.md", basename: "Companion", mentionCount: 1 }]);
  });

  it("honors the cap", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`Clippings/n${i}.md`, "Knowledge graphs.", { source_enriched: true }));
    expect(wireUpItems(entries, CANDIDATES, "Clippings", 25)).toHaveLength(25);
  });
});
