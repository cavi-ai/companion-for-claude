import { describe, it, expect } from "vitest";
import {
  selectDigests,
  buildConsolidationPrompt,
  parseConsolidation,
  renderMemoryNote,
  MEMORY_NOTE_BASENAME,
  type DigestSource,
} from "../src/memory/consolidate";

const digest = (path: string, mtime: number, body = "did things"): DigestSource => ({
  path,
  mtime,
  content: `---\nsession_id: s-${mtime}\ntags:\n  - claude\n  - session\n---\n\n# Session\n\n${body}\n`,
});

describe("selectDigests", () => {
  it("keeps only digest notes (session_id frontmatter), newest first, capped", () => {
    const files: DigestSource[] = [
      digest("Claude/Sessions/a.md", 1),
      digest("Claude/Sessions/b.md", 3),
      { path: "Claude/Sessions/random.md", mtime: 9, content: "# Not a digest\nplain note" },
      digest("Claude/Sessions/c.md", 2),
    ];
    const out = selectDigests(files, { max: 2 });
    expect(out.map((d) => d.path)).toEqual(["Claude/Sessions/b.md", "Claude/Sessions/c.md"]);
  });

  it("excludes the memory note itself", () => {
    const memory: DigestSource = {
      path: `Claude/Sessions/${MEMORY_NOTE_BASENAME}.md`,
      mtime: 99,
      content: "---\nsession_id: bogus\ntype: claude-memory\n---\nbody",
    };
    expect(selectDigests([memory, digest("Claude/Sessions/a.md", 1)]).map((d) => d.path)).toEqual(["Claude/Sessions/a.md"]);
  });

  it("respects the total char budget by dropping oldest digests", () => {
    const big = digest("Claude/Sessions/big.md", 2, "x".repeat(5000));
    const newer = digest("Claude/Sessions/new.md", 3, "y".repeat(5000));
    const out = selectDigests([big, newer], { maxChars: 6000 });
    expect(out.map((d) => d.path)).toEqual(["Claude/Sessions/new.md"]);
  });
});

describe("buildConsolidationPrompt", () => {
  it("includes existing memory, digests, and the format rules", () => {
    const p = buildConsolidationPrompt("## Projects\n- shipping agent mode", ["digest one", "digest two"]);
    expect(p).toContain("shipping agent mode");
    expect(p).toContain("digest one");
    expect(p).toContain("digest two");
    expect(p).toMatch(/absolute dates/i);
    expect(p).toMatch(/##/);
  });

  it("handles the first run (no existing note)", () => {
    const p = buildConsolidationPrompt(null, ["digest one"]);
    expect(p).toMatch(/no existing memory note/i);
  });
});

describe("parseConsolidation", () => {
  it("trims and passes through plain markdown", () => {
    expect(parseConsolidation("\n## Projects\n- a fact\n")).toBe("## Projects\n- a fact");
  });

  it("strips a full-body code fence", () => {
    expect(parseConsolidation("```markdown\n## Projects\n- a fact\n```")).toBe("## Projects\n- a fact");
  });

  it("rejects an empty or trivial reply", () => {
    expect(() => parseConsolidation("   \n")).toThrow(/empty/i);
    expect(() => parseConsolidation("ok")).toThrow(/short/i);
  });
});

describe("renderMemoryNote", () => {
  it("renders claude-memory frontmatter with the body", () => {
    const note = renderMemoryNote("## Projects\n- a fact", { updated: "2026-07-05", digestCount: 4, baseTags: ["claude", "memory"] });
    expect(note).toMatch(/^---\n/);
    expect(note).toContain('type: "claude-memory"');
    expect(note).toContain('updated: "2026-07-05"');
    expect(note).toContain("digests: 4");
    expect(note).toContain(`# ${MEMORY_NOTE_BASENAME}`);
    expect(note).toContain("## Projects\n- a fact");
  });
});
