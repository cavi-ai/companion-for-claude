import { describe, it, expect } from "vitest";
import { readFrontmatter } from "../../src/mcp/frontmatterRead";

const parse = (yaml: string): unknown => {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

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
