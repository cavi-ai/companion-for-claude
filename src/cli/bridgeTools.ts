// The chat-scoped bridge's registry: the run's tool access over the vault tools, the CLI's permission prompt, and the diff-reviewed edit. Pure; modals are injected.

import { PROPOSE_EDIT_DEF, toolAccess, type ToolAccess, type ToolRunKind } from "../agent/toolAccess";
import type { McpToolDef } from "../mcp/protocol";
import type { ToolRegistry } from "../mcp/server";
import type { ToolUseBlock } from "../providers/types";
import { CLI_PERMISSION_TOOL, cliToolName, stripCliToolName } from "./argv";

export interface InteractiveToolDeps {
  confirmWrite(block: ToolUseBlock): Promise<boolean>;
  proposeEdit(block: ToolUseBlock): Promise<string>;
}

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

/** Auto-approved bridge tools: everything the run offers except calls that need confirmation, with the bridge prefix. */
export function cliAllowedTools(defs: McpToolDef[], access: ToolAccess): string[] {
  return access.offered([...defs, PROPOSE_EDIT_DEF]).filter((d) => access.decide(d.name) !== "confirm").map((d) => cliToolName(d.name));
}

/** The result returned to a backend without a permission-prompt tool when the user declines a write. */
export const WRITE_DECLINED_RESULT = "Write declined by the user.";

export interface BridgeBinding {
  run: ToolRunKind;
  deps: InteractiveToolDeps;
  /**
   * True for Claude Code, which asks through the listed permission tool before calling a tool it was not
   * pre-approved for. Without it (codex, opencode) the bridge itself confirms each write before it runs.
   */
  permissionPrompt: boolean;
  /** Why a known tool is off right now, reported instead of the generic refusal. */
  unavailable?: (name: string) => string | undefined;
}

/** The vault tools are read live, so a setting change reaches the next list or call. */
export function bridgeTools(base: ToolRegistry, binding: BridgeBinding): ToolRegistry {
  const { run, deps, permissionPrompt } = binding;
  const current = (): { defs: McpToolDef[]; access: ToolAccess } => {
    const defs = base.definitions();
    return { defs, access: toolAccess(run, defs) };
  };
  return {
    definitions: () => {
      const { defs, access } = current();
      const offered = access.offered([...defs, PROPOSE_EDIT_DEF]);
      return permissionPrompt ? [...offered, PERMISSION_PROMPT_MCP_DEF] : offered;
    },
    call: async (name, args) => {
      if (permissionPrompt && name === CLI_PERMISSION_TOOL) {
        const block = parsePermissionPromptArgs(args);
        return permissionPromptResult(await deps.confirmWrite(block), block.input);
      }
      const decision = current().access.decide(name);
      if (decision === "deny") throw new Error(binding.unavailable?.(name) ?? `Tool unavailable in this run: ${name}.`);
      if (decision === "propose") return deps.proposeEdit({ type: "tool_use", id: "cli", name, input: args });
      if (decision === "confirm" && !permissionPrompt) {
        const allowed = await deps.confirmWrite({ type: "tool_use", id: "cli", name, input: args });
        if (!allowed) return WRITE_DECLINED_RESULT;
      }
      return base.call(name, args);
    },
  };
}
