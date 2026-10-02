// The chat empty state's research quick actions: the project's chat-kind next steps.
import type { NextStep } from "../../research/nextSteps";

export interface ResearchQuickAction {
  label: string;
  prompt: string;
}

const MAX_QUICK_ACTIONS = 3;

export function researchQuickActions(steps: NextStep[]): ResearchQuickAction[] {
  return steps.flatMap((step) => step.kind === "chat" && step.prompt ? [{ label: step.label, prompt: step.prompt }] : []).slice(0, MAX_QUICK_ACTIONS);
}

/** The chat empty state's "DO THE NEXT THING" row under the research workspace card. */
export function renderResearchQuickActions(mount: HTMLElement, actions: ResearchQuickAction[], onRun: (prompt: string) => void): void {
  const quick = mount.createDiv({ cls: "cc-research-quick-actions" });
  quick.createDiv({ cls: "cc-research-quick-label", text: "DO THE NEXT THING" });
  const row = quick.createDiv({ cls: "cc-research-quick-row" });
  for (const action of actions) {
    const button = row.createEl("button", { cls: "cc-research-quick-action", text: action.label });
    button.addEventListener("click", () => onRun(action.prompt));
  }
}
