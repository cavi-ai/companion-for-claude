import type { AgentTurnResult } from "../agent/loop";

/** Decide whether a turn that finished with no chat view attached should surface a Notice + status-bar item. */
export function shouldNotifyTurnComplete(notifyOnTurnComplete: boolean, result: AgentTurnResult): boolean {
  if (!notifyOnTurnComplete) return false;
  if (result.error && !result.text.trim() && result.trace.length === 0) return false;
  return true;
}
