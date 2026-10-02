// One order run: build the prompt, offer read tools plus propose_note_edit, collect proposals without applying them.
// The model call is injected, so this is pure.

import { isWriteTool, PROPOSE_EDIT_TOOL } from "../agent/tools";
import { parseProposedEdits, planEdits, type ProposedEdit } from "../edit/diff";
import type { AgentTurnResult } from "../agent/loop";
import type { AnthropicToolDef, ToolUseBlock } from "../providers/types";
import type { StandingOrder } from "./order";

export type OrderTrigger = { kind: "schedule" } | { kind: "note"; path: string; content: string };

export interface OrderTurnRequest { prompt: string; tools: AnthropicToolDef[]; model?: string }
export interface OrderProposal { path: string; edits: ProposedEdit[]; description?: string }

export interface OrderRunDeps {
  readTools: AnthropicToolDef[];
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
  const tools = deps.toolsSupported ? [...deps.readTools.filter((tool) => !isWriteTool(tool.name)), PROPOSE_EDIT_TOOL] : [];

  const proposeEdit = async (block: ToolUseBlock): Promise<string> => {
    const path = typeof block.input.path === "string" ? block.input.path : "";
    if (!path) throw new Error("propose_note_edit requires a 'path'.");
    const edits = parseProposedEdits(block.input.edits);
    planEdits(await deps.readNote(path), edits);
    const description = typeof block.input.description === "string" && block.input.description ? block.input.description : undefined;
    proposals.push({ path, edits, ...(description ? { description } : {}) });
    return "Queued for review.";
  };

  const request: OrderTurnRequest = { prompt: buildOrderPrompt(order, trigger, now), tools, ...(order.model ? { model: order.model } : {}) };
  try {
    const turn = await deps.runTurn(request, proposeEdit);
    return { text: turn.text, proposals, ...(turn.error ? { error: turn.error } : {}) };
  } catch (error) {
    return { text: "", proposals, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
