// The recovery rows rendered under a conversation: the interrupted/capped turn
// prompt and the saved-edit-proposal prompt. DOM-only; behavior lives in the
// callbacks the view supplies.

import type { Conversation } from "../../conversations/store";

export function removeInterruptedTurnRow(host: HTMLElement): void {
  host.querySelector(".cc-interrupted-turn")?.remove();
}

export function renderInterruptedTurnRow(host: HTMLElement, conversation: Conversation, onResume: (conversation: Conversation) => void): void {
  // One row at a time: a re-capped continuation replaces the stale prompt.
  removeInterruptedTurnRow(host);
  const capped = conversation.activeTurn?.state === "capped";
  const row = host.createDiv({ cls: "cc-agent-notice cc-interrupted-turn" });
  row.createSpan({
    text: capped
      ? "Claude reached the tool-iteration limit before finishing. Its work so far is saved."
      : "This task was interrupted. Review any partial changes before resuming.",
  });
  const resume = row.createEl("button", { text: capped ? "Continue" : "Resume", cls: "mod-cta" });
  resume.addEventListener("click", () => onResume(conversation));
}

export function renderRecoverableEditRow(host: HTMLElement, conversation: Conversation, onReview: (conversation: Conversation) => void): void {
  const proposal = conversation.lastEditProposal;
  if (!proposal || host.querySelector(".cc-edit-recovery")) return;
  const row = host.createDiv({ cls: "cc-agent-notice cc-edit-recovery" });
  row.createSpan({ text: `Proposed edit for ${proposal.path} is saved.` });
  const review = row.createEl("button", { text: "Review proposed edit", cls: "mod-cta" });
  review.addEventListener("click", () => onReview(conversation));
}
