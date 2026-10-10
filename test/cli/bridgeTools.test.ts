import { describe, it, expect } from "vitest";
import { bridgeTools, CLI_HIDDEN_TOOLS, cliAllowedTools, parsePermissionPromptArgs, permissionPromptResult, WRITE_DECLINED_RESULT } from "../../src/cli/bridgeTools";
import { toolAccess, type ToolRunKind } from "../../src/agent/toolAccess";
import type { McpToolDef } from "../../src/mcp/protocol";
import type { ToolUseBlock } from "../../src/providers/types";

const defs: McpToolDef[] = [
  { name: "vault_search", description: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "note_read", description: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "note_create", description: "create", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
];

function harness(run: ToolRunKind, permissionPrompt: boolean, allow = true) {
  const seen: string[] = [];
  const base = { definitions: () => defs, call: async (name: string, args: Record<string, unknown>) => { seen.push(`base:${name}`); return `${name}:${JSON.stringify(args)}`; } };
  const deps = {
    confirmWrite: async (b: ToolUseBlock) => { seen.push(`confirm:${b.name}`); return allow; },
    proposeEdit: async (b: ToolUseBlock) => { seen.push(`propose:${String(b.input.path)}`); return `edited:${String(b.input.path)}`; },
  };
  const tools = bridgeTools(base, { run, deps, permissionPrompt });
  return { tools, seen, names: () => tools.definitions().map((d) => d.name) };
}

describe("cliAllowedTools", () => {
  it("auto-approves reads and propose_note_edit in chat, never a write", () => {
    expect(cliAllowedTools(defs, toolAccess("chat", defs))).toEqual(["mcp__obsidian-vault__vault_search", "mcp__obsidian-vault__note_read", "mcp__obsidian-vault__propose_note_edit"]);
  });
  it("auto-approves reads only in Plan Mode", () => {
    expect(cliAllowedTools(defs, toolAccess("plan", defs))).toEqual(["mcp__obsidian-vault__vault_search", "mcp__obsidian-vault__note_read"]);
  });
  it("auto-approves reads and propose_note_edit for a propose-only run", () => {
    expect(cliAllowedTools(defs, toolAccess("propose", defs))).toEqual(["mcp__obsidian-vault__vault_search", "mcp__obsidian-vault__note_read", "mcp__obsidian-vault__propose_note_edit"]);
  });
  it("auto-approves nothing when tools are off", () => {
    expect(cliAllowedTools(defs, toolAccess("off", defs))).toEqual([]);
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

describe("bridgeTools with a permission prompt (Claude Code)", () => {
  it("lists what the run offers plus the permission tool Claude Code validates at startup", () => {
    expect(harness("chat", true).names()).toEqual(["vault_search", "note_read", "note_create", "propose_note_edit", "permission_prompt"]);
    expect(harness("plan", true).names()).toEqual(["vault_search", "note_read", "permission_prompt"]);
    expect(harness("propose", true).names()).toEqual(["vault_search", "note_read", "propose_note_edit", "permission_prompt"]);
    expect(harness("off", true).names()).toEqual(["permission_prompt"]);
    expect(CLI_HIDDEN_TOOLS.size).toBe(0);
  });

  it("routes the permission prompt to confirmWrite, propose_note_edit to review, and a chat write to the vault", async () => {
    const h = harness("chat", true, false);
    expect(JSON.parse(await h.tools.call("permission_prompt", { tool_name: "mcp__obsidian-vault__note_create", input: {}, tool_use_id: "x" }))).toEqual({ behavior: "deny", message: "User declined." });
    expect(await h.tools.call("propose_note_edit", { path: "A.md", edits: [] })).toBe("edited:A.md");
    expect(await h.tools.call("vault_search", { query: "q" })).toBe('vault_search:{"query":"q"}');
    expect(await h.tools.call("note_create", { title: "S" })).toBe('note_create:{"title":"S"}');
    expect(h.seen).toEqual(["confirm:note_create", "propose:A.md", "base:vault_search", "base:note_create"]);
  });

  it("refuses writes in Plan Mode and propose-only runs, and every vault call when tools are off", async () => {
    for (const run of ["plan", "propose"] as const) {
      const h = harness(run, true);
      await expect(h.tools.call("note_create", { title: "S" })).rejects.toThrow("Tool unavailable in this run: note_create.");
      expect(h.seen).toEqual([]);
    }
    await expect(harness("plan", true).tools.call("propose_note_edit", { path: "A.md", edits: [] })).rejects.toThrow(/unavailable/);
    await expect(harness("off", true).tools.call("vault_search", { query: "q" })).rejects.toThrow(/unavailable/);
  });
});

describe("bridgeTools refusals", () => {
  it("report a switched-off tool's own reason, and the generic refusal otherwise", async () => {
    const base = { definitions: () => defs, call: async () => "ran" };
    const deps = { confirmWrite: async () => true, proposeEdit: async () => "" };
    const unavailable = (name: string) => (name === "web_search" ? "Web search is disabled." : undefined);
    const tools = bridgeTools(base, { run: "chat", deps, permissionPrompt: false, unavailable });
    await expect(tools.call("web_search", { query: "q" })).rejects.toThrow("Web search is disabled.");
    await expect(tools.call("nope", {})).rejects.toThrow("Tool unavailable in this run: nope.");
  });
});

describe("bridgeTools without a permission prompt (codex, opencode)", () => {
  it("lists exactly what the run offers", () => {
    expect(harness("chat", false).names()).toEqual(["vault_search", "note_read", "note_create", "propose_note_edit"]);
    expect(harness("plan", false).names()).toEqual(["vault_search", "note_read"]);
    expect(harness("propose", false).names()).toEqual(["vault_search", "note_read", "propose_note_edit"]);
    expect(harness("off", false).names()).toEqual([]);
  });

  it("confirms a chat write before it runs and passes reads straight through", async () => {
    const h = harness("chat", false);
    expect(await h.tools.call("note_create", { title: "S" })).toBe('note_create:{"title":"S"}');
    expect(await h.tools.call("vault_search", { query: "q" })).toBe('vault_search:{"query":"q"}');
    expect(h.seen).toEqual(["confirm:note_create", "base:note_create", "base:vault_search"]);
  });

  it("returns the declined result and never runs the write when the user declines", async () => {
    const h = harness("chat", false, false);
    expect(await h.tools.call("note_create", { title: "S" })).toBe(WRITE_DECLINED_RESULT);
    expect(h.seen).toEqual(["confirm:note_create"]);
  });

  it("refuses writes in Plan Mode and propose-only runs without asking, and routes propose_note_edit to review", async () => {
    for (const run of ["plan", "propose"] as const) {
      const h = harness(run, false);
      await expect(h.tools.call("note_create", { title: "S" })).rejects.toThrow("Tool unavailable in this run: note_create.");
      expect(h.seen).toEqual([]);
    }
    const h = harness("propose", false);
    expect(await h.tools.call("propose_note_edit", { path: "A.md", edits: [] })).toBe("edited:A.md");
    await expect(harness("off", false).tools.call("vault_search", { query: "q" })).rejects.toThrow(/unavailable/);
  });
});
