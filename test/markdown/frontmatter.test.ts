import { describe, it, expect } from "vitest";
import { frontmatterBlock, readFrontmatter, stripFrontmatter } from "../../src/markdown/frontmatter";

const parse = (yaml: string): unknown => {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

describe("frontmatterBlock", () => {
  it("locates the leading block", () => {
    const content = "---\ntype: person\nrole: engineer\n---\nbody";
    expect(frontmatterBlock(content)).toEqual({ yaml: "type: person\nrole: engineer", end: content.indexOf("body"), closeLine: 3, eol: "\n" });
  });

  it("treats an empty block as a block, not as the start of the body", () => {
    const content = "---\n---\nIntro paragraph.\n\n---\n\nSection two.\n";
    expect(frontmatterBlock(content)).toEqual({ yaml: "", end: 8, closeLine: 1, eol: "\n" });
    expect(stripFrontmatter(content)).toBe("Intro paragraph.\n\n---\n\nSection two.\n");
  });

  it("handles CRLF and trailing spaces on either fence", () => {
    const content = "--- \r\ntitle: a\r\n---  \r\nBody\r\n";
    expect(frontmatterBlock(content)).toEqual({ yaml: "title: a", end: content.indexOf("Body"), closeLine: 2, eol: "\r\n" });
  });

  it("closes on the first fence line only, never on a longer rule or a fence inside a value", () => {
    expect(frontmatterBlock("---\na: 1\n----\nb: 2\n---\nbody")?.yaml).toBe("a: 1\n----\nb: 2");
    expect(frontmatterBlock("---\na: 1\n--- x\n---\nbody")?.yaml).toBe("a: 1\n--- x");
  });

  it("ends at the content end when the closing fence is the last line", () => {
    expect(frontmatterBlock("---\na: 1\n---")).toEqual({ yaml: "a: 1", end: 12, closeLine: 2, eol: "\n" });
  });

  it("is null without an opening fence on the first line or without a closing fence", () => {
    expect(frontmatterBlock("Hello\n---\nworld")).toBeNull();
    expect(frontmatterBlock("---\nunclosed: true\n")).toBeNull();
    expect(frontmatterBlock("---")).toBeNull();
    expect(frontmatterBlock(" ---\na: 1\n---\n")).toBeNull();
    expect(stripFrontmatter("---\nunclosed: true\n")).toBe("---\nunclosed: true\n");
  });
});

describe("readFrontmatter", () => {
  it("parses the leading block", () => {
    expect(readFrontmatter("---\ntype: person\nrole: engineer\n---\nbody", parse)).toEqual({ type: "person", role: "engineer" });
  });
  it("handles CRLF", () => {
    expect(readFrontmatter("---\r\ntype: person\r\n---\r\nbody", parse)).toEqual({ type: "person" });
  });
  it("returns null without a block", () => {
    expect(readFrontmatter("no frontmatter", parse)).toBeNull();
  });
  it("returns null when the block is not a mapping or the parser throws", () => {
    expect(readFrontmatter("---\n- a\n---\n", () => ["a"])).toBeNull();
    expect(readFrontmatter("---\nx: 1\n---\n", () => { throw new Error("bad"); })).toBeNull();
  });
});
