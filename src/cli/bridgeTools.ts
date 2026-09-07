// The chat-scoped bridge's interactive tools: the CLI's permission prompt and the diff-reviewed edit. Pure; modals are injected.

import { isWriteTool, PROPOSE_EDIT_TOOL } from "../agent/tools";
import type { McpToolDef } from "../mcp/protocol";
import type { ToolRegistry } from "../mcp/server";
import type { ToolUseBlock } from "../providers/types";
import { CLI_PERMISSION_TOOL, CLI_PROPOSE_EDIT_TOOL, cliToolName, stripCliToolName } from "./argv";

export interface InteractiveToolDeps {
  confirmWrite(block: ToolUseBlock): Promise<boolean>;
  proposeEdit(block: ToolUseBlock): Promise<string>;
}

export const PROPOSE_EDIT_MCP_DEF: McpToolDef = {
  name: CLI_PROPOSE_EDIT_TOOL,
  description: PROPOSE_EDIT_TOOL.description,
  inputSchema: PROPOSE_EDIT_TOOL.input_schema,
};

/** Claude Code resolves --permission-prompt-tool against tools/list, so the permission tool is listed, not hidden. */
export const CLI_HIDDEN_TOOLS: ReadonlySet<string> = new Set();

export const PERMISSION_PROMPT_MCP_DEF: McpToolDef = {
  name: CLI_PERMISSION_TOOL,
  description: "Internal permission handler for Companion. Never call this tool.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input", "tool_use_id"],
  },
};

export function parsePermissionPromptArgs(args: Record<string, unknown>): ToolUseBlock {
  const name = typeof args.tool_name === "string" ? stripCliToolName(args.tool_name) : "";
  const id = typeof args.tool_use_id === "string" ? args.tool_use_id : "";
  const input = args.input && typeof args.input === "object" && !Array.isArray(args.input) ? (args.input as Record<string, unknown>) : {};
  if (!name || !id) throw new Error("permission_prompt requires tool_name and tool_use_id");
  return { type: "tool_use", id, name, input };
}

export function permissionPromptResult(allowed: boolean, input: Record<string, unknown>): string {
  return JSON.stringify(allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "User declined." });
}

/** Auto-approved bridge tools: reads, plus the diff-reviewed edit outside Plan Mode. Writes route to the permission tool. */
export function cliAllowedTools(defs: McpToolDef[], readOnly: boolean): string[] {
  const reads = defs.filter((d) => !isWriteTool(d.name)).map((d) => cliToolName(d.name));
  return readOnly ? reads : [...reads, cliToolName(CLI_PROPOSE_EDIT_TOOL)];
}

/** `tools` false (agent mode off) lists only the permission tool, which Claude Code validates at startup. */
export function interactiveTools(base: ToolRegistry, deps: () => InteractiveToolDeps | null, readOnly: () => boolean, tools: () => boolean): ToolRegistry {
  return {
    definitions: () => {
      if (!tools()) return [PERMISSION_PROMPT_MCP_DEF];
      const defs = base.definitions();
      if (readOnly()) return [...defs.filter((d) => !isWriteTool(d.name)), PERMISSION_PROMPT_MCP_DEF];
      return [...defs, PROPOSE_EDIT_MCP_DEF, PERMISSION_PROMPT_MCP_DEF];
    },
    call: async (name, args) => {
      if (name === CLI_PERMISSION_TOOL) {
        const block = parsePermissionPromptArgs(args);
        const bound = deps();
        const allowed = bound ? await bound.confirmWrite(block) : false;
        return permissionPromptResult(allowed, block.input);
      }
      if (name === CLI_PROPOSE_EDIT_TOOL) {
        const bound = deps();
        if (!bound) throw new Error("propose_note_edit is unavailable: no chat is bound to this bridge.");
        return bound.proposeEdit({ type: "tool_use", id: "cli", name, input: args });
      }
      if (!tools()) throw new Error(`Tool unavailable: agent mode is off (${name}).`);
      return base.call(name, args);
    },
  };
}
