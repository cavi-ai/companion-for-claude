import { describe, expect, it } from "vitest";
import { DISTILL_SCHEMA, distillInput, notesTouched, parseDistill, renderDistilledNote } from "../../src/conversations/distill";
import type { ChatMessage } from "../../src/types";

const valid = { title: "Plan", summary: "We planned.", decisions: ["Ship it"], facts: ["Uses X"], openItems: ["Test Y"] };

describe("distillInput", () => {
  it("labels turns, uses content over display, drops tool trace and excluded turns", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "real question", display: "shown label" },
      { role: "assistant", content: "real answer", toolTrace: [{ name: "note_read", argsSummary: "A.md", resultPreview: "TOOLNOISE-123", ok: true }] },
      { role: "user", content: "interrupted", contextExcluded: true },
    ];
    const { text, redactions } = distillInput(messages);
    expect(text).toBe("User: real question\n\nClaude: real answer");
    expect(text).not.toContain("TOOLNOISE");
    expect(text).not.toContain("shown label");
    expect(redactions).toBe(0);
  });

  it("replaces artifact blocks with a titled placeholder", () => {
    const html = "<html><head><title>Roadmap</title></head><body>SECRETBODY</body></html>";
    const { text } = distillInput([{ role: "assistant", content: `Here:\n\`\`\`claude-html height=300\n${html}\n\`\`\`\nDone.` }]);
    expect(text).toContain("[artifact: Roadmap]");
    expect(text).not.toContain("SECRETBODY");
  });

  it("returns empty text when the chat holds only tool output and artifacts", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolTrace: [{ name: "note_read", argsSummary: "A.md", resultPreview: "x", ok: true }] },
      { role: "assistant", content: "```claude-html\n<h1>X</h1>\n```" },
    ];
    expect(distillInput(messages)).toEqual({ text: "", redactions: 0 });
  });

  it("redacts secrets and counts them", () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    const { text, redactions } = distillInput([{ role: "user", content: `my key is ${key}` }]);
    expect(text).not.toContain("sk-ant-");
    expect(redactions).toBe(1);
  });

  it("caps long input keeping the head and the tail", () => {
    const head = "H".repeat(5_000);
    const tail = "T".repeat(25_000);
    const { text } = distillInput([{ role: "user", content: `${head}${"M".repeat(30_000)}${tail}` }]);
    expect(text).toContain("…[middle omitted]…");
    expect(text.startsWith("User: HHH")).toBe(true);
    expect(text.endsWith("T".repeat(20_000))).toBe(true);
    expect(text).not.toContain("M");
    expect(text.length).toBeLessThan(24_100);
  });
});

describe("parseDistill", () => {
  it("accepts a valid object, including a fenced one", () => {
    expect(parseDistill(JSON.stringify(valid))).toEqual(valid);
    expect(parseDistill(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
  });

  it("throws on missing summary, non-array lists, long titles, empty items, and bad JSON", () => {
    expect(() => parseDistill(JSON.stringify({ ...valid, summary: "" }))).toThrow(/summary/);
    expect(() => parseDistill(JSON.stringify({ title: "t", decisions: [] }))).toThrow(/summary/);
    expect(() => parseDistill(JSON.stringify({ ...valid, facts: "nope" }))).toThrow(/facts/);
    expect(() => parseDistill(JSON.stringify({ ...valid, title: "x".repeat(81) }))).toThrow(/title/);
    expect(() => parseDistill(JSON.stringify({ ...valid, decisions: ["ok", " "] }))).toThrow(/decisions/);
    expect(() => parseDistill(JSON.stringify({ ...valid, openItems: Array(21).fill("x") }))).toThrow(/openItems/);
    expect(() => parseDistill("not json")).toThrow(/JSON/);
  });

  it("schema requires the five fields", () => {
    expect(DISTILL_SCHEMA.required).toEqual(["title", "summary", "decisions", "facts", "openItems"]);
  });
});

describe("notesTouched", () => {
  const files = new Map([["Notes/A", "Notes/A.md"], ["Notes/B", "Notes/B.md"], ["Notes/C", "Notes/C.md"], ["Note", "Projects/Note.md"]]);
  const resolve = (link: string): string | null => {
    const bare = link.replace(/\.md$/, "");
    return files.get(bare) ?? (link.endsWith(".md") && [...files.values()].includes(link) ? link : null);
  };

  it("collects tool paths and wikilinks through resolve, existing only, deduped", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "See [[Notes/B]] and [[Notes/Missing]] and [[Notes/A|alias]]",
        toolTrace: [
          { name: "note_read", argsSummary: '{"path":"Notes/A.md"}', resultPreview: "", ok: true },
          { name: "note_move", argsSummary: '{"path":"Notes/Gone.md","to":"Notes/C.md"}', resultPreview: "", ok: true },
          { name: "vault_search", argsSummary: '{"query":"Notes/A.md"}', resultPreview: "", ok: true },
          { name: "propose_note_edit", argsSummary: "Notes/A.md", resultPreview: "", ok: true },
        ],
      },
    ];
    expect(notesTouched(messages, resolve)).toEqual(["Notes/A.md", "Notes/C.md", "Notes/B.md"]);
  });

  it("resolves a bare wikilink to a subfolder note's full path and drops unresolvable links", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "[[Note]] [[Nowhere]] [[Note#Heading]]" }];
    expect(notesTouched(messages, resolve)).toEqual(["Projects/Note.md"]);
  });

  it("passes wikilink text without .md and tool paths as-is", () => {
    const seen: string[] = [];
    notesTouched(
      [{ role: "assistant", content: "[[Notes/A.md]]", toolTrace: [{ name: "note_read", argsSummary: '{"path":"Notes/B.md"}', resultPreview: "", ok: true }] }],
      (link) => { seen.push(link); return null; },
    );
    expect(seen).toEqual(["Notes/B.md", "Notes/A"]);
  });

  it("caps at 30", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: Array.from({ length: 40 }, (_, i) => `[[N${i}]]`).join(" ") }];
    expect(notesTouched(messages, (link) => `${link}.md`)).toHaveLength(30);
  });
});

describe("renderDistilledNote", () => {
  const meta = { conversationId: "conv-1", created: "2026-10-05", notes: ["Notes/A.md"], tags: ["claude", "chat"] };

  it("renders frontmatter and sections", () => {
    const out = renderDistilledNote(valid, meta);
    expect(out).toContain('type: "chat-summary"');
    expect(out).toContain('conversation: "conv-1"');
    expect(out).toContain("# Plan");
    for (const h of ["## Summary", "## Decisions", "## Facts", "## Open items", "## Notes touched"]) expect(out).toContain(h);
    expect(out).toContain("- [[Notes/A]]");
  });

  it("omits empty sections", () => {
    const out = renderDistilledNote({ ...valid, decisions: [], openItems: [] }, { ...meta, notes: [] });
    expect(out).not.toContain("## Decisions");
    expect(out).not.toContain("## Open items");
    expect(out).not.toContain("## Notes touched");
    expect(out).toContain("## Facts");
  });
});
