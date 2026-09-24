import { describe, it, expect } from "vitest";
import { CLI_HIDDEN_TOOLS, cliAllowedTools, gatedWriteTools, interactiveTools, parsePermissionPromptArgs, perTurnTools, permissionPromptResult, PROPOSE_EDIT_MCP_DEF, WRITE_DECLINED_RESULT } from "../../src/cli/bridgeTools";
import type { McpToolDef } from "../../src/mcp/protocol";

const defs: McpToolDef[] = [
  { name: "vault_search", description: "search", inputSchema: { type: "object" } },
  { name: "note_read", description: "read", inputSchema: { type: "object" } },
  { name: "note_create", description: "create", inputSchema: { type: "object" } },
];
const base = { definitions: () => defs, call: async (name: string, args: Record<string, unknown>) => `${name}:${JSON.stringify(args)}` };

describe("cliAllowedTools", () => {
  it("lists read tools plus propose_note_edit with the bridge prefix, never writes", () => {
    expect(cliAllowedTools(defs, false)).toEqual(["mcp__obsidian-vault__vault_search", "mcp__obsidian-vault__note_read", "mcp__obsidian-vault__propose_note_edit"]);
  });
  it("drops propose_note_edit in read-only (plan) mode", () => {
    expect(cliAllowedTools(defs, true)).toEqual(["mcp__obsidian-vault__vault_search", "mcp__obsidian-vault__note_read"]);
  });
});

describe("permission prompt", () => {
  it("parses the CLI's prompt payload into a ToolUseBlock without the bridge prefix", () => {
    expect(parsePermissionPromptArgs({ tool_name: "mcp__obsidian-vault__note_create", input: { title: "S" }, tool_use_id: "toolu_1" }))
      .toEqual({ type: "tool_use", id: "toolu_1", name: "note_create", input: { title: "S" } });
    expect(() => parsePermissionPromptArgs({ input: {} })).toThrow(/tool_name/);
  });
  it("returns the allow/deny JSON Claude Code expects", () => {
    expect(JSON.parse(permissionPromptResult(true, { a: 1 }))).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
    expect(JSON.parse(permissionPromptResult(false, { a: 1 }))).toEqual({ behavior: "deny", message: "User declined." });
  });
});

describe("interactiveTools", () => {
  it("lists propose_note_edit unless read-only, and always lists the permission tool Claude Code validates at startup", () => {
    const rw = interactiveTools(base, () => null, () => false, () => true);
    expect(rw.definitions().map((d) => d.name)).toEqual(["vault_search", "note_read", "note_create", "propose_note_edit", "permission_prompt"]);
    const ro = interactiveTools(base, () => null, () => true, () => true);
    expect(ro.definitions().map((d) => d.name)).toEqual(["vault_search", "note_read", "permission_prompt"]);
    expect(PROPOSE_EDIT_MCP_DEF.name).toBe("propose_note_edit");
    expect(CLI_HIDDEN_TOOLS.size).toBe(0);
  });
  it("routes permission_prompt to confirmWrite and propose_note_edit to proposeEdit, else to the base", async () => {
    const seen: string[] = [];
    const deps = { confirmWrite: async (b: { name: string }) => { seen.push(`confirm:${b.name}`); return false; }, proposeEdit: async (b: { input: Record<string, unknown> }) => `edited:${String(b.input.path)}` };
    const t = interactiveTools(base, () => deps, () => false, () => true);
    expect(JSON.parse(await t.call("permission_prompt", { tool_name: "mcp__obsidian-vault__note_create", input: {}, tool_use_id: "x" }))).toEqual({ behavior: "deny", message: "User declined." });
    expect(await t.call("propose_note_edit", { path: "A.md", edits: [] })).toBe("edited:A.md");
    expect(await t.call("vault_search", { query: "q" })).toBe('vault_search:{"query":"q"}');
    expect(seen).toEqual(["confirm:note_create"]);
  });
  it("lists only the permission tool and refuses vault calls when agent mode is off", async () => {
    const off = interactiveTools(base, () => null, () => false, () => false);
    expect(off.definitions().map((d) => d.name)).toEqual(["permission_prompt"]);
    await expect(off.call("vault_search", { query: "q" })).rejects.toThrow(/agent mode is off/);
  });
  it("denies interactive tools when no chat is bound", async () => {
    const t = interactiveTools(base, () => null, () => false, () => true);
    expect(JSON.parse(await t.call("permission_prompt", { tool_name: "mcp__obsidian-vault__note_create", input: {}, tool_use_id: "x" }))).toEqual({ behavior: "deny", message: "User declined." });
    await expect(t.call("propose_note_edit", { path: "A.md", edits: [] })).rejects.toThrow(/no chat/);
  });
});

describe("gatedWriteTools (backends with no --permission-prompt-tool equivalent)", () => {
  it("awaits confirmWrite for a write tool and executes once on allow", async () => {
    const seen: string[] = [];
    const deps = { confirmWrite: async (b: { name: string }) => { seen.push(b.name); return true; }, proposeEdit: async () => "" };
    const t = gatedWriteTools(base, () => deps);
    expect(await t.call("note_create", { title: "S" })).toBe('note_create:{"title":"S"}');
    expect(seen).toEqual(["note_create"]);
  });

  it("returns the declined result and never calls base on deny", async () => {
    const calls: string[] = [];
    const denyingBase = { definitions: () => defs, call: async (name: string) => { calls.push(name); return "should not run"; } };
    const deps = { confirmWrite: async () => false, proposeEdit: async () => "" };
    const t = gatedWriteTools(denyingBase, () => deps);
    expect(await t.call("note_create", { title: "S" })).toBe(WRITE_DECLINED_RESULT);
    expect(calls).toEqual([]);
  });

  it("denies by default when no chat is bound", async () => {
    const t = gatedWriteTools(base, () => null);
    expect(await t.call("note_create", { title: "S" })).toBe(WRITE_DECLINED_RESULT);
  });

  it("passes read tools straight through without gating", async () => {
    const seen: string[] = [];
    const deps = { confirmWrite: async (b: { name: string }) => { seen.push(b.name); return true; }, proposeEdit: async () => "" };
    const t = gatedWriteTools(base, () => deps);
    expect(await t.call("vault_search", { query: "q" })).toBe('vault_search:{"query":"q"}');
    expect(seen).toEqual([]);
  });
});

describe("perTurnTools (codex, opencode)", () => {
  it("lists every tool and gates writes through confirmWrite", async () => {
    const seen: string[] = [];
    const deps = { confirmWrite: async (b: { name: string }) => { seen.push(b.name); return true; }, proposeEdit: async () => "" };
    const t = perTurnTools(base, () => deps, () => false, () => true);
    expect(t.definitions().map((d) => d.name)).toEqual(["vault_search", "note_read", "note_create"]);
    expect(await t.call("note_create", { title: "S" })).toBe('note_create:{"title":"S"}');
    expect(seen).toEqual(["note_create"]);
  });
  it("hides write tools from the list in Plan Mode, as well as gating them", async () => {
    const t = perTurnTools(base, () => ({ confirmWrite: async () => false, proposeEdit: async () => "" }), () => true, () => true);
    expect(t.definitions().map((d) => d.name)).toEqual(["vault_search", "note_read"]);
    expect(await t.call("note_create", { title: "S" })).toBe(WRITE_DECLINED_RESULT);
  });
  it("lists nothing and refuses every call when agent mode is off", async () => {
    const t = perTurnTools(base, () => null, () => false, () => false);
    expect(t.definitions()).toEqual([]);
    await expect(t.call("vault_search", { query: "q" })).rejects.toThrow(/agent mode is off/);
  });
});
