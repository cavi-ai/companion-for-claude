// One order run: build the prompt, offer read tools plus propose_note_edit, collect proposals without applying them.
// The model call is injected, so this is pure.

import { toAnthropicTools } from "../agent/tools";
import { PROPOSE_EDIT_DEF, toolAccess, type ToolRunKind } from "../agent/toolAccess";
import type { McpToolDef } from "../mcp/protocol";
import { parseProposedEdits, planEdits, type ProposedEdit } from "../edit/diff";
import type { AgentTurnResult } from "../agent/loop";
import type { AnthropicToolDef, ToolUseBlock } from "../providers/types";
import type { StandingOrder } from "./order";

export type OrderTrigger = { kind: "schedule" } | { kind: "note"; path: string; content: string };

/** `run` is the tool access the turn must enforce on every call: propose-only, or off without tool support. */
export interface OrderTurnRequest { prompt: string; tools: AnthropicToolDef[]; run: ToolRunKind; model?: string }
export interface OrderProposal { path: string; edits: ProposedEdit[]; description?: string }

export interface OrderRunDeps {
  /** Every vault tool; the run offers the ones propose-only access allows. */
  vaultTools: McpToolDef[];
  toolsSupported: boolean;
  /** Throws when the note is missing. */
  readNote(path: string): Promise<string>;
  runTurn(request: OrderTurnRequest, proposeEdit: (block: ToolUseBlock) => Promise<string>): Promise<AgentTurnResult>;
}

export interface OrderRunResult { text: string; proposals: OrderProposal[]; error?: Error }

function isoDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function buildOrderPrompt(order: StandingOrder, trigger: OrderTrigger, now: Date): string {
  const noteBlock = trigger.kind === "note" ? `Note: ${trigger.path}\n\n${trigger.content}` : "";
  const body = order.prompt.replace(/\{date\}/g, isoDate(now));
  if (/\{note\}/.test(body)) return body.replace(/\{note\}/g, () => noteBlock);
  return noteBlock ? `${body}\n\n${noteBlock}` : body;
}

export async function runOrder(order: StandingOrder, trigger: OrderTrigger, now: Date, deps: OrderRunDeps): Promise<OrderRunResult> {
  const proposals: OrderProposal[] = [];
  const run: ToolRunKind = deps.toolsSupported ? "propose" : "off";
  const tools = toAnthropicTools(toolAccess(run, deps.vaultTools).offered([...deps.vaultTools, PROPOSE_EDIT_DEF]));

  const proposeEdit = async (block: ToolUseBlock): Promise<string> => {
    const path = typeof block.input.path === "string" ? block.input.path : "";
    if (!path) throw new Error("propose_note_edit requires a 'path'.");
    const edits = parseProposedEdits(block.input.edits);
    planEdits(await deps.readNote(path), edits);
    const description = typeof block.input.description === "string" && block.input.description ? block.input.description : undefined;
    proposals.push({ path, edits, ...(description ? { description } : {}) });
    return "Queued for review.";
  };

  const request: OrderTurnRequest = { prompt: buildOrderPrompt(order, trigger, now), tools, run, ...(order.model ? { model: order.model } : {}) };
  try {
    const turn = await deps.runTurn(request, proposeEdit);
    return { text: turn.text, proposals, ...(turn.error ? { error: turn.error } : {}) };
  } catch (error) {
    return { text: "", proposals, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
