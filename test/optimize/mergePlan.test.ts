import { describe, expect, it } from "vitest";
import { collapseMerges, mapTagList, planTagMerges, renderRunNote, rewriteInlineTags } from "../../src/optimize/mergePlan";

describe("collapseMerges", () => {
  it("rewrites a chain a→b, b→c to a→c and b→c", () => {
    const { map, cycles } = collapseMerges([{ from: "a", to: "b" }, { from: "b", to: "c" }]);
    expect(Object.fromEntries(map)).toEqual({ a: "c", b: "c" });
    expect(cycles).toEqual([]);
  });

  it("drops a cycle whole and reports it once", () => {
    const { map, cycles, dropped } = collapseMerges([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "x", to: "y" },
    ]);
    expect(Object.fromEntries(map)).toEqual({ x: "y" });
    expect(cycles).toEqual([["a", "b", "c"]]);
    expect(dropped.sort()).toEqual(["a", "b", "c"]);
  });

  it("drops a chain that feeds a cycle, keeps the first target of a duplicate from, ignores self merges", () => {
    const { map, cycles } = collapseMerges([
      { from: "d", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "m", to: "n" },
      { from: "m", to: "z" },
      { from: "s", to: "S" },
    ]);
    expect(Object.fromEntries(map)).toEqual({ m: "n" });
    expect(cycles).toEqual([["a", "b"]]);
  });
});

describe("mapTagList", () => {
  const map = new Map([["llms", "llm"]]);

  it("ends with one llm for [llms, llm] and keeps unmapped spelling", () => {
    expect(mapTagList(["llms", "llm", "My_Tag"], map)).toEqual({ tags: ["llm", "My_Tag"], changed: true });
  });

  it("looks up by tag id", () => {
    expect(mapTagList(["#LLMs"], map)).toEqual({ tags: ["llm"], changed: true });
  });

  it("never removes or retypes an unmapped entry", () => {
    expect(mapTagList(["llms", "🌱", "📥"], map)).toEqual({ tags: ["llm", "🌱", "📥"], changed: true });
    expect(mapTagList(["LLMs", "x", "x"], map)).toEqual({ tags: ["llm", "x", "x"], changed: true });
    expect(mapTagList(["llms", null, 2024], map)).toEqual({ tags: ["llm", null, 2024], changed: true });
    expect(mapTagList(["a", "b"], map)).toEqual({ tags: ["a", "b"], changed: false });
    expect(mapTagList(["Foo", "foo"], map)).toEqual({ tags: ["Foo", "foo"], changed: false });
  });

  it("drops a mapped entry whose target is kept or already emitted", () => {
    expect(mapTagList(["llms", "llm"], map)).toEqual({ tags: ["llm"], changed: true });
    const two = new Map([["llms", "llm"], ["llmz", "llm"]]);
    expect(mapTagList(["llms", "llmz"], two)).toEqual({ tags: ["llm"], changed: true });
  });
});

describe("planTagMerges", () => {
  const map = new Map([["ai", "artificial-intelligence"], ["llms", "llm"]]);

  it("plans frontmatter and inline edits, leaves nested tags and untouched notes alone", () => {
    const plans = planTagMerges(map, [
      { path: "a.md", frontmatterTags: ["llms", "llm"], inline: [{ tag: "LLMs", start: 5, end: 10 }, { tag: "ai/agents", start: 20, end: 29 }] },
      { path: "b.md", frontmatterTags: ["other"], inline: [] },
    ]);
    expect(plans).toEqual([
      { path: "a.md", before: ["llms", "llm"], after: ["llm"], inline: [{ start: 5, end: 10, from: "llms", to: "llm" }] },
    ]);
  });
});

describe("rewriteInlineTags", () => {
  it("turns inline #LLMs into #llm, applying last offset first", () => {
    const content = "x #LLMs and #llms y";
    const edits = [
      { start: 2, end: 7, from: "llms", to: "llm" },
      { start: 12, end: 17, from: "llms", to: "llm" },
    ];
    expect(rewriteInlineTags(content, edits)).toEqual({ content: "x #llm and #llm y", applied: 2, skipped: 0, appliedFrom: ["llms", "llms"] });
  });

  it("skips and counts an occurrence whose text at the offsets is no longer the tag", () => {
    const edits = [{ start: 0, end: 5, from: "llms", to: "llm" }];
    expect(rewriteInlineTags("moved #llms", edits)).toEqual({ content: "moved #llms", applied: 0, skipped: 1, appliedFrom: [] });
  });

  it("skips an edit whose tag continues past the cached end", () => {
    const edits = [
      { start: 4, end: 7, from: "ai", to: "artificial-intelligence" },
      { start: 19, end: 22, from: "ai", to: "artificial-intelligence" },
    ];
    const content = "see #ai/agents and #aim";
    expect(rewriteInlineTags(content, edits)).toEqual({ content, applied: 0, skipped: 2, appliedFrom: [] });
  });

  it("applies when the tag ends at end of content or before punctuation, skips before a tag character", () => {
    const edit = (n: number) => [{ start: 2, end: 2 + n, from: "llms", to: "llm" }];
    expect(rewriteInlineTags("a #llms.", edit(5)).applied).toBe(1);
    expect(rewriteInlineTags("a #llms", edit(5)).applied).toBe(1);
    expect(rewriteInlineTags("a #llms🌱", edit(5)).skipped).toBe(1);
    expect(rewriteInlineTags("a #llms-x", edit(5)).skipped).toBe(1);
  });
});

describe("renderRunNote", () => {
  it("writes merges in code spans so no #<from> is a live tag", () => {
    const note = renderRunNote({ applied: [{ from: "llms", to: "llm", paths: ["Notes/a.md"] }], failed: [], orders: [] }, "2026-10-05T12:00:00.000Z");
    expect(note).toContain("`llms` → `llm`");
    expect(note).toContain("[[Notes/a]]");
    expect(note).not.toContain("#llms");
    expect(note).not.toMatch(/#llm\b/);
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).not.toContain("## ");
  });

  it("adds sections for failed paths and affected orders only when present", () => {
    const note = renderRunNote(
      { applied: [{ from: "a", to: "b", paths: ["n.md"] }], failed: ["bad.md"], orders: [{ path: "T/o.md", tag: "a" }] },
      "2026-10-05T12:00:00.000Z",
    );
    expect(note).toContain("## Not rewritten\n\n- `bad.md`");
    expect(note).not.toContain("[[bad");
    expect(note).toContain("## Standing orders that trigger on a merged tag\n\n- [[T/o]] — `a`");
  });
});
