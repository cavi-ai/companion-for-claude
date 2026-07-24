import { describe, it, expect, vi } from "vitest";
import { toAnthropicTools, executeTool, isWriteTool, TOOL_RESULT_MAX_CHARS, PROPOSE_EDIT_TOOL } from "../src/agent/tools";
import type { McpToolDef } from "../src/mcp/protocol";
import type { ToolUseBlock } from "../src/providers/types";
import { VaultTools } from "../src/mcp/vaultTools";
import { App } from "obsidian";

const defs: McpToolDef[] = [
  { name: "vault_search", description: "Search.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "note_create", description: "Create.", inputSchema: { type: "object", properties: {} } },
];

const use = (name: string, input: Record<string, unknown> = {}, extra?: Partial<ToolUseBlock>): ToolUseBlock => ({
  type: "tool_use",
  id: "toolu_1",
  name,
  input,
  ...extra,
});

describe("toAnthropicTools", () => {
  it("maps inputSchema to input_schema and keeps name/description", () => {
    expect(toAnthropicTools(defs)).toEqual([
      { name: "vault_search", description: "Search.", input_schema: defs[0]!.inputSchema },
      { name: "note_create", description: "Create.", input_schema: defs[1]!.inputSchema },
    ]);
  });
});

describe("isWriteTool", () => {
  it("classifies the five write tools and nothing else", () => {
    for (const t of ["note_create", "note_append", "note_update", "update_frontmatter", "note_move"]) {
      expect(isWriteTool(t)).toBe(true);
    }
    for (const t of ["vault_search", "note_read", "list_recent", "vault_tags", "list_titles", "get_backlinks", "get_outgoing_links", "frontmatter_query"]) {
      expect(isWriteTool(t)).toBe(false);
    }
  });

  it("fails closed for every research mutation while keeping project reads and audits read-only", async () => {
    for (const name of ["research_project_create", "research_source_import", "research_evidence_capture", "research_evidence_review", "research_claim_create", "research_claim_link", "research_outline_generate", "research_evidence_create", "research_outline_create"]) {
      expect(isWriteTool(name)).toBe(true);
      const call = vi.fn();
      const result = await executeTool({ call }, use(name));
      expect(call).not.toHaveBeenCalled();
      expect(result.is_error).toBe(true);
    }
    expect(isWriteTool("research_project_read")).toBe(false);
    expect(isWriteTool("research_audit")).toBe(false);
  });

  it("transforms only canonical research definitions for the model", () => {
    const advertised = new VaultTools(new App() as never, { allowWrites: true, defaultFolder: "Claude" }).definitions();
    const names = toAnthropicTools(advertised).map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.startsWith("research_"))).toEqual([
      "research_project_read",
      "research_audit",
      "research_project_create",
      "research_source_import",
      "research_evidence_capture",
      "research_evidence_review",
      "research_claim_create",
      "research_claim_link",
      "research_outline_generate",
    ]);
    expect(names).not.toContain("research_evidence_create");
    expect(names).not.toContain("research_outline_create");
  });
});

describe("executeTool", () => {
  it("runs a read tool and returns its text", async () => {
    const call = vi.fn().mockResolvedValue("## A.md\nsnippet");
    const r = await executeTool({ call }, use("vault_search", { query: "x" }));
    expect(call).toHaveBeenCalledWith("vault_search", { query: "x" });
    expect(r).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "## A.md\nsnippet" });
  });

  it("truncates oversized results with a marker", async () => {
    const big = "x".repeat(TOOL_RESULT_MAX_CHARS + 500);
    const call = vi.fn().mockResolvedValue(big);
    const r = await executeTool({ call }, use("note_read", { path: "A.md" }));
    expect(r.content.length).toBeLessThan(big.length);
    expect(r.content).toContain("[truncated — 500 chars omitted]");
    expect(r.content.startsWith("x".repeat(100))).toBe(true);
  });

  it("returns is_error when the tool throws", async () => {
    const call = vi.fn().mockRejectedValue(new Error("Note not found: A.md"));
    const r = await executeTool({ call }, use("note_read", { path: "A.md" }));
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("Note not found");
  });

  it("returns is_error for a block with parseError without calling the tool", async () => {
    const call = vi.fn();
    const r = await executeTool({ call }, use("note_read", {}, { parseError: "Tool input was not valid JSON: x" }));
    expect(call).not.toHaveBeenCalled();
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("not valid JSON");
  });

  it("asks the write gate before running a write tool", async () => {
    const call = vi.fn().mockResolvedValue("Created note: X.md");
    const confirmWrite = vi.fn().mockResolvedValue(true);
    const r = await executeTool({ call, confirmWrite }, use("note_create", { title: "X", content: "y" }));
    expect(confirmWrite).toHaveBeenCalled();
    expect(r.content).toBe("Created note: X.md");
  });

  it("returns a declined is_error when the gate denies", async () => {
    const call = vi.fn();
    const confirmWrite = vi.fn().mockResolvedValue(false);
    const r = await executeTool({ call, confirmWrite }, use("note_create", { title: "X", content: "y" }));
    expect(call).not.toHaveBeenCalled();
    expect(r.is_error).toBe(true);
    expect(r.content).toBe("User declined.");
  });

  it("refuses write tools when no gate is wired (fail closed)", async () => {
    const call = vi.fn();
    const r = await executeTool({ call }, use("note_update", { path: "A.md", content: "z" }));
    expect(call).not.toHaveBeenCalled();
    expect(r.is_error).toBe(true);
  });

  it("never asks the gate for read tools", async () => {
    const call = vi.fn().mockResolvedValue("- #tag (3)");
    const confirmWrite = vi.fn();
    await executeTool({ call, confirmWrite }, use("vault_tags"));
    expect(confirmWrite).not.toHaveBeenCalled();
  });
});

describe("propose_note_edit routing", () => {
  const proposeBlock = use("propose_note_edit", { path: "A.md", edits: [{ old_str: "a", new_str: "b" }] });

  it("routes to the proposeEdit handler, not VaultTools.call", async () => {
    const call = vi.fn();
    const proposeEdit = vi.fn().mockResolvedValue("Applied all 1 edit to A.md.");
    const r = await executeTool({ call, proposeEdit }, proposeBlock);
    expect(call).not.toHaveBeenCalled();
    expect(proposeEdit).toHaveBeenCalledWith(proposeBlock);
    expect(r.content).toBe("Applied all 1 edit to A.md.");
    expect(r.is_error).toBeUndefined();
  });

  it("fails closed when no handler is wired", async () => {
    const r = await executeTool({ call: vi.fn() }, proposeBlock);
    expect(r.is_error).toBe(true);
  });

  it("maps handler throws (plan errors, staleness) to is_error", async () => {
    const proposeEdit = vi.fn().mockRejectedValue(new Error("old_str not found in the note"));
    const r = await executeTool({ call: vi.fn(), proposeEdit }, proposeBlock);
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("not found");
  });

  it("never asks the write gate (the diff modal is the gate)", async () => {
    const confirmWrite = vi.fn();
    await executeTool({ call: vi.fn(), confirmWrite, proposeEdit: vi.fn().mockResolvedValue("ok") }, proposeBlock);
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it("is not classified as a write tool", () => {
    expect(isWriteTool("propose_note_edit")).toBe(false);
  });

  it("has a valid definition shape", () => {
    expect(PROPOSE_EDIT_TOOL.name).toBe("propose_note_edit");
    const schema = PROPOSE_EDIT_TOOL.input_schema as { required?: string[] };
    expect(schema.required).toEqual(["path", "edits"]);
  });
});

describe("canvas_create classification", () => {
  it("is a write tool (vault mutation — gated + confirmed)", () => {
    expect(isWriteTool("canvas_create")).toBe(true);
  });
});

describe("base_create classification", () => {
  it("is a write tool (vault mutation — gated + confirmed)", () => {
    expect(isWriteTool("base_create")).toBe(true);
  });
});
