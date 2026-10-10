// Adapter between the existing VaultTools (MCP shapes) and the Anthropic
// tool-use loop: schema mapping, per-call routing by the run's tool access, and result truncation.
// Pure — the actual vault access is injected as `call`.

import type { McpToolDef } from "../mcp/protocol";
import type { AnthropicToolDef, ToolResultBlock, ToolUseBlock } from "../providers/types";
import { PROPOSE_EDIT_DEF, type ToolAccess } from "./toolAccess";

/** Cap on a single tool result sent back to the model (spec §7, Franco-approved). */
export const TOOL_RESULT_MAX_CHARS = 8000;

/** Map MCP tool definitions to the Anthropic Messages API shape. */
export function toAnthropicTools(defs: McpToolDef[]): AnthropicToolDef[] {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema }));
}

/** propose_note_edit in the Messages API shape. */
export const PROPOSE_EDIT_TOOL: AnthropicToolDef = toAnthropicTools([PROPOSE_EDIT_DEF])[0]!;

export interface ToolExecutorDeps {
  /** Decides, per call, whether the tool runs, needs confirmation, routes to edit review, or is refused. */
  access: ToolAccess;
  /** Why a known tool is off right now (e.g. web search disabled), reported instead of the generic refusal. */
  unavailable?(name: string): string | undefined;
  signal?: AbortSignal;
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
  if (deps.signal?.aborted) return result("Turn stopped before this tool ran.", true);
  const decision = deps.access.decide(block.name);
  if (decision === "deny") return result(deps.unavailable?.(block.name) ?? `Tool unavailable in this run: ${block.name}.`, true);
  if (decision === "propose") {
    if (!deps.proposeEdit) return result("Edit proposals are unavailable in this chat.", true);
    try {
      return result(truncateResult(await deps.proposeEdit(block)));
    } catch (err) {
      return result(err instanceof Error ? err.message : String(err), true);
    }
  }
  if (decision === "confirm") {
    if (!deps.confirmWrite) return result("Write tools are unavailable in this chat.", true);
    if (!(await deps.confirmWrite(block))) return result("User declined.", true);
    if (deps.signal?.aborted) return result("Turn stopped before this write ran.", true);
  }
  if (deps.signal?.aborted) return result("Turn stopped before this tool ran.", true);
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
