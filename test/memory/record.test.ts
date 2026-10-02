import { describe, it, expect } from "vitest";
import {
  RECORDED_HEADING,
  RECORDED_CAP,
  FACT_MAX,
  formatRecordLine,
  splitRecorded,
  appendRecord,
} from "../../src/memory/record";

const date = "2026-10-02";
const newNote = (body: string) => `---\ntype: claude-memory\n---\n\n# What Claude Knows\n\n${body}\n`;
const added = (r: ReturnType<typeof appendRecord>) => {
  if (r.kind !== "added") throw new Error(`expected added, got ${JSON.stringify(r)}`);
  return r.content;
};

describe("formatRecordLine", () => {
  it("formats date, source, topic and fact", () => {
    expect(formatRecordLine({ fact: "Prefers terse answers", topic: "style", source: "codex", date })).toBe(
      "- 2026-10-02 · codex · [style] Prefers terse answers",
    );
  });

  it("omits the topic when absent or blank", () => {
    expect(formatRecordLine({ fact: "Uses pnpm", source: "codex", date })).toBe("- 2026-10-02 · codex · Uses pnpm");
    expect(formatRecordLine({ fact: "Uses pnpm", topic: "  [] ", source: "codex", date })).toBe("- 2026-10-02 · codex · Uses pnpm");
  });

  it("normalizes the source and defaults it to agent", () => {
    expect(formatRecordLine({ fact: "x1", source: "  Claude Code!! ", date })).toBe("- 2026-10-02 · claude-code · x1");
    expect(formatRecordLine({ fact: "x1", date })).toBe("- 2026-10-02 · agent · x1");
    expect(formatRecordLine({ fact: "x1", source: "***", date })).toBe("- 2026-10-02 · agent · x1");
    const long = formatRecordLine({ fact: "x1", source: "a".repeat(80), date });
    expect(long).toBe(`- 2026-10-02 · ${"a".repeat(32)} · x1`);
  });

  it("caps the topic at 40 chars on one line", () => {
    const line = formatRecordLine({ fact: "x1", topic: `a\nb${"c".repeat(60)}`, source: "s", date });
    expect(line).toBe(`- 2026-10-02 · s · [a b${"c".repeat(37)}] x1`);
  });

  it("collapses the fact to one line", () => {
    expect(formatRecordLine({ fact: "  line one\n\n  line   two\t", source: "s", date })).toBe("- 2026-10-02 · s · line one line two");
  });

  it("scrubs secrets from the fact", () => {
    const line = formatRecordLine({ fact: "Key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ok", source: "s", date });
    expect(typeof line).toBe("string");
    expect(line).not.toContain("sk-ant-");
  });

  it("rejects an empty fact and an over-long fact", () => {
    expect(formatRecordLine({ fact: "  \n ", source: "s", date })).toEqual({ error: "fact is empty" });
    expect(formatRecordLine({ fact: "a".repeat(FACT_MAX + 1), source: "s", date })).toEqual({ error: "fact is over 500 characters" });
    expect(typeof formatRecordLine({ fact: "a".repeat(FACT_MAX), source: "s", date })).toBe("string");
  });
});

describe("appendRecord", () => {
  it("creates the note with memory frontmatter and the section as body", () => {
    const content = added(appendRecord(null, { fact: "Prefers terse answers", source: "codex", date }, newNote));
    expect(content).toContain("type: claude-memory");
    expect(content).toContain(`${RECORDED_HEADING}\n\n- 2026-10-02 · codex · Prefers terse answers\n`);
  });

  it("stores a fact containing an API key scrubbed", () => {
    const content = added(appendRecord(null, { fact: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", source: "s", date }, newNote));
    expect(content).not.toContain("sk-ant-");
  });

  it("appends the section after a note whose last section is not ours, and keeps it last", () => {
    const base = "# What Claude Knows\n\n## Projects\n\n- Alpha\n";
    const one = added(appendRecord(base, { fact: "First fact", source: "a", date }, newNote));
    expect(one.indexOf("## Projects")).toBeLessThan(one.indexOf(RECORDED_HEADING));
    const two = added(appendRecord(one, { fact: "Second fact", source: "b", date }, newNote));
    expect(two.indexOf(RECORDED_HEADING)).toBeGreaterThan(two.indexOf("## Projects"));
    expect(two.match(new RegExp(RECORDED_HEADING, "g"))).toHaveLength(1);
    expect(splitRecorded(two).recorded).toEqual(["- 2026-10-02 · a · First fact", "- 2026-10-02 · b · Second fact"]);
  });

  it("moves our section to the end when a section was added after it", () => {
    const content = `# K\n\n${RECORDED_HEADING}\n\n- 2026-10-01 · a · Old\n\n## Later\n\n- Z\n`;
    const out = added(appendRecord(content, { fact: "New", source: "b", date }, newNote));
    expect(out.indexOf("## Later")).toBeLessThan(out.indexOf(RECORDED_HEADING));
    expect(splitRecorded(out).recorded).toHaveLength(2);
  });

  it("treats the same normalized fact as a duplicate and does not write", () => {
    const one = added(appendRecord(null, { fact: "Prefers  Terse answers", topic: "style", source: "a", date }, newNote));
    expect(appendRecord(one, { fact: "prefers terse   ANSWERS", source: "b", date: "2026-10-03" }, newNote)).toEqual({ kind: "duplicate" });
  });

  it("reports empty and over-long facts as errors", () => {
    expect(appendRecord(null, { fact: "", source: "a", date }, newNote)).toEqual({ kind: "error", message: "fact is empty" });
    expect(appendRecord(null, { fact: "a".repeat(501), source: "a", date }, newNote)).toEqual({ kind: "error", message: "fact is over 500 characters" });
  });

  it("refuses a 201st entry", () => {
    let content = "# K\n";
    for (let i = 0; i < RECORDED_CAP; i++) content = added(appendRecord(content, { fact: `fact number ${i}`, source: "a", date }, newNote));
    expect(splitRecorded(content).recorded).toHaveLength(RECORDED_CAP);
    expect(appendRecord(content, { fact: "one too many", source: "a", date }, newNote)).toEqual({
      kind: "error",
      message: "Memory inbox is full (200). Run Consolidate memory.",
    });
  });
});

describe("splitRecorded", () => {
  it("returns the content untouched when there is no section", () => {
    expect(splitRecorded("# K\n\n## A\n\n- x\n")).toEqual({ body: "# K\n\n## A\n\n- x\n", recorded: [] });
  });

  it("separates the section lines from the body", () => {
    const { body, recorded } = splitRecorded(`# K\n\n## A\n\n- x\n\n${RECORDED_HEADING}\n\n- 2026-10-02 · a · F\n`);
    expect(body).toBe("# K\n\n## A\n\n- x\n");
    expect(recorded).toEqual(["- 2026-10-02 · a · F"]);
  });
});
