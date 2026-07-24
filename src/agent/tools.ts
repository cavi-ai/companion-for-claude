// Adapter between the existing VaultTools (MCP shapes) and the Anthropic
// tool-use loop: schema mapping, write gating, and result truncation.
// Pure — the actual vault access is injected as `call`.

import type { McpToolDef } from "../mcp/protocol";
import type { AnthropicToolDef, ToolResultBlock, ToolUseBlock } from "../providers/types";
import { RESEARCH_WRITE_TOOLS } from "../research/tools";

/** Cap on a single tool result sent back to the model (spec §7, Franco-approved). */
export const TOOL_RESULT_MAX_CHARS = 8000;

/** The vault tools that mutate the vault; everything else is read-only. */
const WRITE_TOOLS = new Set(["note_create", "note_append", "note_update", "update_frontmatter", "note_move", "canvas_create", "base_create", ...RESEARCH_WRITE_TOOLS]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

/** Map MCP tool definitions to the Anthropic Messages API shape. */
export function toAnthropicTools(defs: McpToolDef[]): AnthropicToolDef[] {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema }));
}

/**
 * Chat-only edit-proposal tool (spec 2026-07-05 apply-to-note). Not a write
 * tool: the user reviews a per-hunk diff before anything touches the vault,
 * so it is offered even when autonomous writes are off.
 */
export const PROPOSE_EDIT_TOOL: AnthropicToolDef = {
  name: "propose_note_edit",
  description:
    "Propose targeted edits to an existing note. The user reviews a diff and accepts or rejects each change; the result reports what was actually applied. Each old_str must match the note exactly once — include surrounding lines to disambiguate. Prefer this over rewriting note content in chat.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the note to edit (e.g. 'Folder/Note.md')." },
      edits: {
        type: "array",
        description: "Exact string replacements, each matching the note exactly once.",
        items: {
          type: "object",
          properties: {
            old_str: { type: "string", description: "Exact existing text to replace (unique in the note)." },
            new_str: { type: "string", description: "Replacement text." },
          },
          required: ["old_str", "new_str"],
        },
      },
      description: { type: "string", description: "One-line summary of the intent, shown to the user above the diff." },
    },
    required: ["path", "edits"],
  },
};

export interface ToolExecutorDeps {
  /** Runs the tool (VaultTools.call). Throws on failure. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /**
   * Asked before every write tool runs (the confirmation modal). Absent →
   * writes fail closed, so a mis-wired caller can never mutate the vault.
   */
  confirmWrite?(block: ToolUseBlock): Promise<boolean>;
  /**
   * Handles a propose_note_edit call (diff review UI). Absent → the tool
   * fails closed, mirroring confirmWrite.
   */
  proposeEdit?(block: ToolUseBlock): Promise<string>;
}

/**
 * Execute one tool_use block and shape the outcome as a tool_result. Errors
 * (including declined writes and malformed input) become `is_error` results so
 * the model can adapt instead of the turn dying.
 */
export async function executeTool(deps: ToolExecutorDeps, block: ToolUseBlock): Promise<ToolResultBlock> {
  const result = (content: string, isError?: boolean): ToolResultBlock => ({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });

  if (block.parseError) return result(block.parseError, true);
  if (block.name === PROPOSE_EDIT_TOOL.name) {
    if (!deps.proposeEdit) return result("Edit proposals are unavailable in this chat.", true);
    try {
      return result(truncateResult(await deps.proposeEdit(block)));
    } catch (err) {
      return result(err instanceof Error ? err.message : String(err), true);
    }
  }
  if (isWriteTool(block.name)) {
    if (!deps.confirmWrite) return result("Write tools are unavailable in this chat.", true);
    if (!(await deps.confirmWrite(block))) return result("User declined.", true);
  }
  try {
    return result(truncateResult(await deps.call(block.name, block.input)));
  } catch (err) {
    return result(err instanceof Error ? err.message : String(err), true);
  }
}

/** Trim an oversized result, telling the model what was cut. */
export function truncateResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const omitted = text.length - TOOL_RESULT_MAX_CHARS;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated — ${omitted} chars omitted]`;
}
