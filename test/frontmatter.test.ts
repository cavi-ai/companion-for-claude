import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { normalizeTag, normalizeTags, buildFrontmatter, parseTagSuggestions, datedTitleBase } from "../src/indexing/frontmatter";
import { parseTaggerOutput } from "../src/indexing/taggerParse";

describe("datedTitleBase", () => {
  it("prefixes an ISO date and cleans the title", () => {
    expect(datedTitleBase("2026-06-03T17:00:00Z", "  Voxtral 4B   TTS Overview ")).toBe("2026-06-03 — Voxtral 4B TTS Overview");
  });
  it("falls back gracefully on empty inputs", () => {
    expect(datedTitleBase("", "")).toBe("undated — Untitled");
  });
});

describe("parseTaggerOutput title", () => {
  it("extracts a clean TITLE line, stripping quotes and trailing punctuation", () => {
    const out = parseTaggerOutput('TITLE: "Vault Optimization Framework."\nTAGS: pkm, obsidian\nSUMMARY: A map of levers.');
    expect(out.title).toBe("Vault Optimization Framework");
    expect(out.tags).toEqual(["pkm", "obsidian"]);
  });
  it("returns an empty title when absent", () => {
    expect(parseTaggerOutput("TAGS: a, b\nSUMMARY: x").title).toBe("");
  });
});

describe("normalizeTag", () => {
  it("strips #, lowercases, hyphenates spaces", () => {
    expect(normalizeTag("#Project Plan")).toBe("project-plan");
  });
  it("collapses and trims separators", () => {
    expect(normalizeTag("  foo   bar  ")).toBe("foo-bar");
    expect(normalizeTag("--edge--")).toBe("edge");
  });
  it("prefixes purely numeric tags (invalid in Obsidian)", () => {
    expect(normalizeTag("2026")).toBe("t-2026");
  });
  it("keeps nested tag slashes", () => {
    expect(normalizeTag("area/ml")).toBe("area/ml");
  });
});

describe("normalizeTags", () => {
  it("dedupes after normalization and drops empties", () => {
    expect(normalizeTags(["Foo", "foo", "#FOO", "", "  "])).toEqual(["foo"]);
  });
});

describe("buildFrontmatter", () => {
  it("round-trips every YAML-like string as a string", () => {
    const values = ["2026", "0014", "1e3", "0x10", "0o10", ".inf", ".nan", "true", "null", "2026-07-13"];
    const yaml = buildFrontmatter(Object.fromEntries(values.map((value, index) => [`v${index}`, value]))).split("\n").slice(1, -1).join("\n");
    const parsed = parseYaml(yaml);
    expect(Object.values(parsed)).toEqual(values);
  });
  it("emits a fenced YAML block with a tag list", () => {
    const fm = buildFrontmatter({ title: "Hi", type: "artifact", tags: ["claude", "plan"] });
    expect(fm).toBe(["---", 'title: "Hi"', 'type: "artifact"', "tags:", '  - "claude"', '  - "plan"', "---"].join("\n"));
  });
  it("quotes values with YAML-special characters", () => {
    const fm = buildFrontmatter({ title: "a: b #c" });
    expect(fm).toContain('title: "a: b #c"');
  });
  it("skips undefined and renders empty arrays as []", () => {
    const fm = buildFrontmatter({ title: "x", summary: undefined, tags: [] });
    expect(fm).not.toContain("summary");
    expect(fm).toContain("tags: []");
  });
  it("renders numbers and booleans unquoted", () => {
    expect(buildFrontmatter({ n: 3, b: true })).toContain("n: 3");
    expect(buildFrontmatter({ n: 3, b: true })).toContain("b: true");
  });
});

describe("parseTagSuggestions", () => {
  it("parses comma and space separated keywords", () => {
    expect(parseTagSuggestions("#Machine Learning, data-pipeline  ingestion")).toEqual(["machine", "learning", "data-pipeline", "ingestion"]);
  });
  it("caps at the requested max", () => {
    expect(parseTagSuggestions("a,b,c,d,e,f", 3)).toEqual(["a", "b", "c"].slice(0, 3));
  });
});

describe("wikilink values (ontology relations)", () => {
  it("round-trips quoted tags and wikilinks through YAML", () => {
    const yaml = buildFrontmatter({ tags: ["research", "phase-1"], parent: "[[Research/Project.md]]" }).split("\n").slice(1, -1).join("\n");
    expect(parseYaml(yaml)).toEqual({ tags: ["research", "phase-1"], parent: "[[Research/Project.md]]" });
  });
  it("quotes wikilinks in lists so Obsidian reads them as link values", () => {
    const fm = buildFrontmatter({ works_on: ["[[CAVI]]", "[[Projects/X|alias]]"] });
    expect(fm).toContain('  - "[[CAVI]]"');
    expect(fm).toContain('  - "[[Projects/X|alias]]"');
  });
  it("quotes a scalar wikilink value", () => {
    expect(buildFrontmatter({ parent: "[[Hub]]" })).toContain('parent: "[[Hub]]"');
  });
});
