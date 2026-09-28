// Continuation policy for turns that stopped early: the resume/continue prompt
// for a receipt, and whether a capped turn may auto-continue. Pure.

import type { ChatTurnReceipt } from "../../conversations/store";
import { handoffResumePrompt } from "../../agent/handoff";

/** Upper bound on chained auto-continuations of capped turns (agentAutoContinue). */
export const MAX_AUTO_CONTINUATIONS = 4;

export interface ContinuationPrompt {
  prompt: string;
  display: string;
  /** Continuation chain depth the new turn should carry. */
  depth: number;
}

/** The resume/continue prompt for a non-running receipt, or null when it isn't resumable. */
export function continuationFor(receipt: ChatTurnReceipt): ContinuationPrompt | null {
  if (receipt.state === "capped") {
    return {
      prompt: receipt.handoff
        ? handoffResumePrompt(receipt.handoff)
        : "Inspect the current vault state, report what the previous turn already completed, and continue only unfinished work. Do not repeat completed writes.",
      display: "Continue task",
      depth: (receipt.continuationDepth ?? 0) + 1,
    };
  }
  if (receipt.state === "interrupted" || receipt.state === "failed") {
    return {
      prompt: "Inspect the current vault state, report what the interrupted task already completed, and continue only unfinished work. Do not repeat completed writes.",
      display: "Resume interrupted task",
      depth: 0,
    };
  }
  return null;
}

/** Auto-continue applies only to capped turns while the chain stays under the cap. */
export function shouldAutoContinue(enabled: boolean, receipt: ChatTurnReceipt | undefined): boolean {
  return enabled && receipt !== undefined && receipt.state === "capped" && (receipt.continuationDepth ?? 0) < MAX_AUTO_CONTINUATIONS;
}
