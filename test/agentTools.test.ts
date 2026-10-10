import { describe, it, expect, vi } from "vitest";
import { toAnthropicTools, executeTool, TOOL_RESULT_MAX_CHARS, PROPOSE_EDIT_TOOL } from "../src/agent/tools";
import { isWriteTool, toolAccess } from "../src/agent/toolAccess";
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

/** Every tool the vault can advertise: writes allowed, memory on, an ontology folder configured. */
const catalog = new VaultTools(new App() as never, {
  allowWrites: true,
  defaultFolder: "Claude",
  memoryRecord: { enabled: () => true, path: () => "Claude/What Claude Knows.md", today: () => "2026-10-07", newNote: (body: string) => body },
  ontology: () => null,
  ontologyFolder: () => "Ontology",
}).definitions();
const writes = (name: string): boolean => {
  const def = catalog.find((candidate) => candidate.name === name);
  if (!def) throw new Error(`not advertised: ${name}`);
  return isWriteTool(def);
};
const chat = toolAccess("chat", catalog);

describe("Plan Mode tool access over the full vault catalog", () => {
  it("offers every read and no write tool or propose_note_edit", () => {
    const names = toolAccess("plan", catalog).offered([...toAnthropicTools(catalog), PROPOSE_EDIT_TOOL]).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(writes(name)).toBe(false);
    expect(names).toContain("vault_search");
    expect(names).not.toContain("note_create");
    expect(names).not.toContain("propose_note_edit");
  });

  it("refuses a write called by name without asking for confirmation", async () => {
    const call = vi.fn();
    const confirmWrite = vi.fn().mockResolvedValue(true);
    const r = await executeTool({ access: toolAccess("plan", catalog), call, confirmWrite }, use("note_create", { title: "X", content: "y" }));
    expect(r).toMatchObject({ is_error: true, content: "Tool unavailable in this run: note_create." });
    expect(confirmWrite).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("toAnthropicTools", () => {
  it("maps inputSchema to input_schema and keeps name/description", () => {
    expect(toAnthropicTools(defs)).toEqual([
      { name: "vault_search", description: "Search.", input_schema: defs[0]!.inputSchema },
      { name: "note_create", description: "Create.", input_schema: defs[1]!.inputSchema },
    ]);
  });
});

describe("write classification from each tool's definition", () => {
  it("marks exactly the vault and research mutations as writes", () => {
    expect(catalog.filter(isWriteTool).map(({ name }) => name).sort()).toEqual([
      "base_create", "canvas_create", "memory_record", "note_append", "note_create", "note_move", "note_patch", "note_update", "ontology_propose",
      "research_claim_create", "research_claim_link", "research_claim_review", "research_evidence_capture", "research_evidence_locate", "research_evidence_review",
      "research_outline_generate", "research_project_create", "research_source_import", "update_frontmatter",
    ]);
    for (const def of catalog) expect(typeof def.annotations?.readOnlyHint).toBe("boolean");
  });

  it("keeps vault reads, research reads, and ontology_get read-only", () => {
    for (const name of ["vault_search", "related_notes", "note_read", "list_recent", "vault_tags", "list_titles", "get_backlinks", "get_outgoing_links", "frontmatter_query", "ontology_get", "research_project_read", "research_audit"]) {
      expect(writes(name)).toBe(false);
    }
  });

  it("treats a definition without the read-only annotation as a write", () => {
    expect(isWriteTool({ name: "x", description: "", inputSchema: {} })).toBe(true);
  });

  it("fails closed for every research mutation and unlisted alias when no confirmation is wired", async () => {
    for (const name of ["research_project_create", "research_source_import", "research_evidence_capture", "research_evidence_review", "research_claim_create", "research_claim_link", "research_outline_generate", "research_evidence_create", "research_outline_create"]) {
      const call = vi.fn();
      const result = await executeTool({ access: chat, call }, use(name));
      expect(call).not.toHaveBeenCalled();
      expect(result.is_error).toBe(true);
    }
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
      "research_evidence_locate",
      "research_claim_review",
      "research_claim_create",
      "research_claim_link",
      "research_outline_generate",
    ]);
    expect(names).not.toContain("research_evidence_create");
    expect(names).not.toContain("research_outline_create");
  });
});

describe("executeTool", () => {
  it("never starts a write after Stop while its confirmation was open", async () => {
    const controller = new AbortController();
    let approve!: (allowed: boolean) => void;
    const call = vi.fn(async () => "written");
    const pending = executeTool({ access: chat, call, signal: controller.signal, confirmWrite: () => new Promise((resolve) => { approve = resolve; }) }, use("note_create"));
    controller.abort();
    approve(true);
    const result = await pending;
    expect(result.is_error).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("runs a read tool and returns its text", async () => {
    const call = vi.fn().mockResolvedValue("## A.md\nsnippet");
    const r = await executeTool({ access: chat, call }, use("vault_search", { query: "x" }));
    expect(call).toHaveBeenCalledWith("vault_search", { query: "x" });
    expect(r).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "## A.md\nsnippet" });
  });

  it("truncates oversized results with a marker", async () => {
    const big = "x".repeat(TOOL_RESULT_MAX_CHARS + 500);
    const call = vi.fn().mockResolvedValue(big);
    const r = await executeTool({ access: chat, call }, use("note_read", { path: "A.md" }));
    expect(r.content.length).toBeLessThan(big.length);
    expect(r.content).toContain("[truncated — 500 chars omitted]");
    expect(r.content.startsWith("x".repeat(100))).toBe(true);
  });

  it("returns is_error when the tool throws", async () => {
    const call = vi.fn().mockRejectedValue(new Error("Note not found: A.md"));
    const r = await executeTool({ access: chat, call }, use("note_read", { path: "A.md" }));
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("Note not found");
  });

  it("returns is_error for a block with parseError without calling the tool", async () => {
    const call = vi.fn();
    const r = await executeTool({ access: chat, call }, use("note_read", {}, { parseError: "Tool input was not valid JSON: x" }));
    expect(call).not.toHaveBeenCalled();
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("not valid JSON");
  });

  it("asks the write gate before running a write tool", async () => {
    const call = vi.fn().mockResolvedValue("Created note: X.md");
    const confirmWrite = vi.fn().mockResolvedValue(true);
    const r = await executeTool({ access: chat, call, confirmWrite }, use("note_create", { title: "X", content: "y" }));
    expect(confirmWrite).toHaveBeenCalled();
    expect(r.content).toBe("Created note: X.md");
  });

  it("returns a declined is_error when the gate denies", async () => {
    const call = vi.fn();
    const confirmWrite = vi.fn().mockResolvedValue(false);
    const r = await executeTool({ access: chat, call, confirmWrite }, use("note_create", { title: "X", content: "y" }));
    expect(call).not.toHaveBeenCalled();
    expect(r.is_error).toBe(true);
    expect(r.content).toBe("User declined.");
  });

  it("refuses write tools when no gate is wired (fail closed)", async () => {
    const call = vi.fn();
    const r = await executeTool({ access: chat, call }, use("note_update", { path: "A.md", content: "z" }));
    expect(call).not.toHaveBeenCalled();
    expect(r.is_error).toBe(true);
  });

  it("never asks the gate for read tools", async () => {
    const call = vi.fn().mockResolvedValue("- #tag (3)");
    const confirmWrite = vi.fn();
    await executeTool({ access: chat, call, confirmWrite }, use("vault_tags"));
    expect(confirmWrite).not.toHaveBeenCalled();
  });
});

describe("propose_note_edit routing", () => {
  const proposeBlock = use("propose_note_edit", { path: "A.md", edits: [{ old_str: "a", new_str: "b" }] });

  it("routes to the proposeEdit handler, not VaultTools.call", async () => {
    const call = vi.fn();
    const proposeEdit = vi.fn().mockResolvedValue("Applied all 1 edit to A.md.");
    const r = await executeTool({ access: chat, call, proposeEdit }, proposeBlock);
    expect(call).not.toHaveBeenCalled();
    expect(proposeEdit).toHaveBeenCalledWith(proposeBlock);
    expect(r.content).toBe("Applied all 1 edit to A.md.");
    expect(r.is_error).toBeUndefined();
  });

  it("fails closed when no handler is wired", async () => {
    const r = await executeTool({ access: chat, call: vi.fn() }, proposeBlock);
    expect(r.is_error).toBe(true);
  });

  it("maps handler throws (plan errors, staleness) to is_error", async () => {
    const proposeEdit = vi.fn().mockRejectedValue(new Error("old_str not found in the note"));
    const r = await executeTool({ access: chat, call: vi.fn(), proposeEdit }, proposeBlock);
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("not found");
  });

  it("never asks the write gate (the diff modal is the gate)", async () => {
    const confirmWrite = vi.fn();
    await executeTool({ access: chat, call: vi.fn(), confirmWrite, proposeEdit: vi.fn().mockResolvedValue("ok") }, proposeBlock);
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it("is not classified as a write tool", () => {
    expect(chat.decide("propose_note_edit")).toBe("propose");
  });

  it("has a valid definition shape", () => {
    expect(PROPOSE_EDIT_TOOL.name).toBe("propose_note_edit");
    const schema = PROPOSE_EDIT_TOOL.input_schema as { required?: string[] };
    expect(schema.required).toEqual(["path", "edits"]);
  });
});

describe("tools that are switched off", () => {
  it("report why when called by name, instead of the generic refusal", async () => {
    const tools = new VaultTools(new App() as never, { allowWrites: false, defaultFolder: "Claude" });
    const access = toolAccess("chat", tools.definitions());
    const call = vi.fn();
    const run = (name: string) => executeTool({ access, unavailable: (n) => tools.unavailable(n), call }, use(name));
    expect((await run("web_search")).content).toBe("Web search is disabled. Enable it in Companion settings → Agent.");
    expect((await run("memory_record")).content).toBe("Memory recording is off in Companion settings.");
    expect((await run("note_create")).content).toBe("Write tools are disabled. Enable 'Allow MCP writes' in Companion for Claude settings.");
    expect((await run("no_such_tool")).content).toBe("Tool unavailable in this run: no_such_tool.");
    expect(call).not.toHaveBeenCalled();
  });

  it("are unknown only by name: an available tool has no reason", () => {
    const tools = new VaultTools(new App() as never, { allowWrites: true, defaultFolder: "Claude", webSearch: async () => "" });
    expect(tools.unavailable("web_search")).toBeUndefined();
    expect(tools.unavailable("note_create")).toBeUndefined();
    expect(tools.unavailable("research_evidence_create")).toBeUndefined();
  });

  it("keep the research wording for an unknown research tool", async () => {
    const tools = new VaultTools(new App() as never, { allowWrites: true, defaultFolder: "Claude" });
    await expect(tools.call("research_nope", {})).rejects.toThrow("Unknown research tool: research_nope");
    await expect(tools.call("nope", {})).rejects.toThrow("Unknown tool: nope");
  });
});

describe("write tools in chat", () => {
  it("asks for confirmation before canvas_create, base_create, ontology_propose, and memory_record", () => {
    for (const name of ["canvas_create", "base_create", "ontology_propose", "memory_record"]) expect(chat.decide(name)).toBe("confirm");
  });
});
