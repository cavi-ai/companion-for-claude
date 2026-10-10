import { describe, expect, it } from "vitest";
import { isWriteTool, PROPOSE_EDIT_DEF, toolAccess, type ToolDecision, type ToolRunKind } from "../../src/agent/toolAccess";
import type { McpToolDef } from "../../src/mcp/protocol";

const def = (name: string, readOnlyHint?: boolean): McpToolDef => ({ name, description: name, inputSchema: { type: "object" }, ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }) });

const read = "vault_search";
const write = "note_create";
const unmarked = "legacy_tool";
const propose = PROPOSE_EDIT_DEF.name;
const external = "mcp__github__create_issue";
const unlisted = "note_delete";
const catalog = [def(read, true), def(write, false), def(unmarked)];

const table: Record<ToolRunKind, Record<string, ToolDecision>> = {
  off: { [read]: "deny", [write]: "deny", [unmarked]: "deny", [propose]: "deny", [external]: "deny", [unlisted]: "deny" },
  plan: { [read]: "run", [write]: "deny", [unmarked]: "deny", [propose]: "deny", [external]: "deny", [unlisted]: "deny" },
  chat: { [read]: "run", [write]: "confirm", [unmarked]: "confirm", [propose]: "propose", [external]: "run", [unlisted]: "deny" },
  propose: { [read]: "run", [write]: "deny", [unmarked]: "deny", [propose]: "propose", [external]: "deny", [unlisted]: "deny" },
};

describe("toolAccess", () => {
  for (const [kind, row] of Object.entries(table) as Array<[ToolRunKind, Record<string, ToolDecision>]>) {
    it(`decides every tool class for a ${kind} run and offers exactly the undenied ones`, () => {
      const access = toolAccess(kind, catalog);
      for (const [name, decision] of Object.entries(row)) expect(access.decide(name)).toBe(decision);
      const candidates = Object.keys(row).map((name) => ({ name }));
      expect(access.offered(candidates).map((t) => t.name)).toEqual(Object.keys(row).filter((name) => row[name] !== "deny"));
    });
  }

  it("treats a definition without the read-only annotation as a write", () => {
    expect(isWriteTool(def(unmarked))).toBe(true);
    expect(isWriteTool(def(write, false))).toBe(true);
    expect(isWriteTool(def(read, true))).toBe(false);
  });

  it("never treats propose_note_edit as a write", () => {
    expect(isWriteTool(PROPOSE_EDIT_DEF)).toBe(false);
  });
});
