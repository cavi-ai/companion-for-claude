import { describe, expect, it } from "vitest";
import { applyPatch, findBlock, findSection } from "../../src/mcp/patch";
import { replaceSection } from "../../src/mcp/edit";

const NOTE = [
  "---",
  "title: Plan",
  "tags: [a]",
  "---",
  "",
  "# Plan",
  "",
  "Intro paragraph. ^intro",
  "",
  "## Tasks",
  "",
  "- [ ] Create the parser ^t1",
  "  with a continuation line",
  "- [ ] Wire the interface",
  "",
  "```sh",
  "# not a heading",
  "```",
  "^code",
  "",
  "## Notes",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "^table",
  "",
  "Last words.",
  "",
].join("\n");

const lines = NOTE.split("\n");

describe("findSection", () => {
  it("finds a heading's body range, skipping fenced code", () => {
    const tasks = findSection(lines, "tasks");
    expect(tasks).toEqual({ heading: 9, body: { start: 10, end: 20 } });
    expect(findSection(lines, "not a heading")).toBeNull();
    expect(findSection(lines, "Plan")).toEqual({ heading: 5, body: { start: 6, end: lines.length } });
  });
});

describe("findBlock", () => {
  it("resolves an inline paragraph id to that paragraph", () => {
    expect(findBlock(lines, "intro")).toEqual({ range: { start: 7, end: 8 }, idLine: 7, inline: true });
  });
  it("resolves a list item id to the item plus its indented continuation", () => {
    expect(findBlock(lines, "t1")).toEqual({ range: { start: 11, end: 13 }, idLine: 11, inline: true });
  });
  it("resolves a standalone id below a fence to the whole fence", () => {
    expect(findBlock(lines, "code")).toEqual({ range: { start: 15, end: 18 }, idLine: 18, inline: false });
  });
  it("resolves a standalone id below a table to the whole table", () => {
    expect(findBlock(lines, "table")).toEqual({ range: { start: 22, end: 25 }, idLine: 25, inline: false });
  });
  it("returns null for an unknown id", () => {
    expect(findBlock(lines, "nope")).toBeNull();
  });
});

describe("applyPatch — heading", () => {
  it("replace matches replaceSection byte for byte", () => {
    const viaPatch = applyPatch(NOTE, { target: { kind: "heading", heading: "Tasks" }, op: "replace", content: "- [x] Done\n" });
    expect(viaPatch).toBe(replaceSection(NOTE, "Tasks", "- [x] Done\n"));
    expect(viaPatch).toContain("## Tasks\n\n- [x] Done\n\n## Notes");
  });
  it("append adds inside the section, before the next heading", () => {
    const out = applyPatch(NOTE, { target: { kind: "heading", heading: "Tasks" }, op: "append", content: "- [ ] Write the tests" });
    expect(out).toContain("^code\n- [ ] Write the tests\n\n## Notes");
  });
  it("prepend adds right after the heading", () => {
    const out = applyPatch(NOTE, { target: { kind: "heading", heading: "Tasks" }, op: "prepend", content: "Zero." });
    expect(out).toContain("## Tasks\n\nZero.\n\n- [ ] Create the parser ^t1");
  });
  it("throws for a missing heading", () => {
    expect(() => applyPatch(NOTE, { target: { kind: "heading", heading: "Missing" }, op: "append", content: "x" })).toThrow("Section not found: Missing");
  });
});

describe("applyPatch — block", () => {
  it("replace keeps an inline id on the new last line", () => {
    const out = applyPatch(NOTE, { target: { kind: "block", id: "t1" }, op: "replace", content: "- [x] Create the tokenizer" });
    expect(out).toContain("- [x] Create the tokenizer ^t1\n- [ ] Wire the interface");
    expect(out).not.toContain("continuation line");
  });
  it("replace keeps a standalone id below the new block", () => {
    const out = applyPatch(NOTE, { target: { kind: "block", id: "table" }, op: "replace", content: "| x |\n| - |" });
    expect(out).toContain("## Notes\n\n| x |\n| - |\n^table\n\nLast words.");
  });
  it("append inserts after the block and its id", () => {
    const out = applyPatch(NOTE, { target: { kind: "block", id: "code" }, op: "append", content: "After code." });
    expect(out).toContain("```\n^code\nAfter code.\n\n## Notes");
  });
  it("prepend inserts before the block", () => {
    const out = applyPatch(NOTE, { target: { kind: "block", id: "intro" }, op: "prepend", content: "Before intro." });
    expect(out).toContain("# Plan\n\nBefore intro.\nIntro paragraph. ^intro");
  });
  it("throws for an unknown id", () => {
    expect(() => applyPatch(NOTE, { target: { kind: "block", id: "zzz" }, op: "append", content: "x" })).toThrow("Block not found: ^zzz");
  });
});

describe("applyPatch — document", () => {
  it("append goes to the end with one blank line", () => {
    expect(applyPatch(NOTE, { target: { kind: "document" }, op: "append", content: "Tail." })).toBe(`${NOTE.replace(/\s+$/, "")}\n\nTail.\n`);
  });
  it("prepend goes right after the frontmatter", () => {
    const out = applyPatch(NOTE, { target: { kind: "document" }, op: "prepend", content: "Head." });
    expect(out.startsWith("---\ntitle: Plan\ntags: [a]\n---\n\nHead.\n\n# Plan")).toBe(true);
  });
  it("replace keeps the frontmatter and swaps the body", () => {
    expect(applyPatch(NOTE, { target: { kind: "document" }, op: "replace", content: "Only this." })).toBe("---\ntitle: Plan\ntags: [a]\n---\n\nOnly this.\n");
  });
  it("works without frontmatter", () => {
    expect(applyPatch("Body.\n", { target: { kind: "document" }, op: "prepend", content: "Top." })).toBe("Top.\n\nBody.\n");
    expect(applyPatch("Body.\n", { target: { kind: "document" }, op: "replace", content: "New." })).toBe("New.\n");
  });
});
