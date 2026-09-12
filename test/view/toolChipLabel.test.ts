import { describe, expect, it } from "vitest";
import { chipLabel, formatToolArgs } from "../../src/view/toolChipLabel";

describe("formatToolArgs", () => {
  it("quotes and caps a search query at 60 chars", () => {
    expect(formatToolArgs("vault_search", { query: "Continuity" })).toBe('"Continuity"');
    expect(formatToolArgs("web_search", { query: "Continuity" })).toBe('"Continuity"');
    const long = "x".repeat(70);
    expect(formatToolArgs("vault_search", { query: long })).toBe(`"${"x".repeat(60)}…"`);
  });

  it("shows a note path verbatim, capped at 80 chars", () => {
    expect(formatToolArgs("note_read", { path: "Research/Alpha/Project.md" })).toBe("Research/Alpha/Project.md");
    for (const name of ["note_append", "note_update", "note_patch", "get_backlinks", "get_outgoing_links", "note_move", "propose_note_edit"]) {
      expect(formatToolArgs(name, { path: "A/B.md" })).toBe("A/B.md");
    }
    const long = "a/".repeat(50) + "note.md";
    expect(formatToolArgs("note_read", { path: long })).toBe(`${long.slice(0, 80)}…`);
  });

  it("shows the title for note_create", () => {
    expect(formatToolArgs("note_create", { title: "New Idea" })).toBe("New Idea");
  });

  it("shows field, plus '= value' when present, for frontmatter_query", () => {
    expect(formatToolArgs("frontmatter_query", { field: "status" })).toBe("status");
    expect(formatToolArgs("frontmatter_query", { field: "status", value: "done" })).toBe("status = done");
  });

  it("shows the host for web_fetch", () => {
    expect(formatToolArgs("web_fetch", { url: "https://example.com/foo/bar?x=1" })).toBe("example.com");
  });

  it("shows the project, or the path when project is absent, for research_* tools", () => {
    expect(formatToolArgs("research_project_read", { project: "Research/Alpha/Project.md" })).toBe("Research/Alpha/Project.md");
    expect(formatToolArgs("research_audit", { project: "Research/Alpha/Project.md" })).toBe("Research/Alpha/Project.md");
    expect(formatToolArgs("research_source_import", { path: "Research/Alpha/Source.md" })).toBe("Research/Alpha/Source.md");
  });

  it("strips the mcp__obsidian-vault__ bridge prefix before mapping", () => {
    expect(formatToolArgs("mcp__obsidian-vault__vault_search", { query: "Continuity" })).toBe('"Continuity"');
  });

  it("falls back to truncated JSON for an unmapped tool", () => {
    expect(formatToolArgs("some_other_tool", { foo: "bar" })).toBe('{"foo":"bar"}');
    const bigValue = "y".repeat(90);
    const json = JSON.stringify({ foo: bigValue });
    expect(formatToolArgs("some_other_tool", { foo: bigValue })).toBe(`${json.slice(0, 80)}…`);
  });

  it("falls back to truncated JSON when a mapped tool is missing its field", () => {
    expect(formatToolArgs("vault_search", { notQuery: "x" })).toBe('{"notQuery":"x"}');
    expect(formatToolArgs("note_read", { notPath: "x" })).toBe('{"notPath":"x"}');
  });

  it("returns '' for an empty object", () => {
    expect(formatToolArgs("some_other_tool", {})).toBe("");
    expect(formatToolArgs("vault_search", {})).toBe("");
  });

  it("returns '' for null or undefined input", () => {
    expect(formatToolArgs("vault_search", undefined)).toBe("");
    expect(formatToolArgs("vault_search", null)).toBe("");
  });
});

describe("chipLabel", () => {
  it("uses human labels and concise note names for built-in tools", () => {
    expect(chipLabel("vault_search", { query: "Continuity" })).toBe('Search vault — "Continuity"');
    expect(chipLabel("note_read", { path: "Research/Alpha/Project.md" })).toBe("Read note — Project");
  });

  it("omits the dash and args entirely when there is nothing to show", () => {
    expect(chipLabel("note_read", {})).toBe("Read note");
  });

  it("shows the path for propose_note_edit, ignoring the edits array", () => {
    expect(chipLabel("propose_note_edit", { path: "Build plan.md", edits: [] })).toBe("Propose edit — Build plan");
  });

  it("strips the chat-bridge's own mcp__obsidian-vault__ prefix for display", () => {
    expect(chipLabel("mcp__obsidian-vault__vault_search", { query: "x" })).toBe('Search vault — "x"');
    expect(chipLabel("mcp__obsidian-vault__note_read", {})).toBe("Read note");
  });

  it("leaves a user-configured external MCP server's namespaced name intact", () => {
    expect(chipLabel("mcp__github__search_issues", {})).toBe("mcp__github__search_issues");
  });

  it("parses a JSON string input and formats it the same as the object", () => {
    expect(chipLabel("vault_search", '{"query":"Continuity"}')).toBe(chipLabel("vault_search", { query: "Continuity" }));
  });

  it("shows a truncated JSON string verbatim when it cannot be parsed", () => {
    expect(chipLabel("note_read", '{"path":"Research/Alpha/Proj…')).toBe("Read note — {\"path\":\"Research/Alpha/Proj…");
  });

  it("returns tool name only when given an empty string input", () => {
    expect(chipLabel("vault_search", "")).toBe("Search vault");
  });
});
