// Map the Research Desk's ranked actions to ready-to-send chat prompts, so the
// chat empty state can offer the project's actual next steps as quick actions.
// Pure; the desk view model supplies the actions.

import type { ResearchDeskAction } from "../../research/deskViewModel";

export interface ResearchQuickAction {
  label: string;
  prompt: string;
}

const MAX_QUICK_ACTIONS = 3;

export function researchQuickActions(actions: ResearchDeskAction[], projectPath: string): ResearchQuickAction[] {
  return actions.slice(0, MAX_QUICK_ACTIONS).map((action) => ({ label: action.label, prompt: promptFor(action, projectPath) }));
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

function promptFor(action: ResearchDeskAction, projectPath: string): string {
  const project = `the research project at ${projectPath}`;
  const record = action.path ? ` (${action.path})` : "";
  switch (action.id.split(":")[0]) {
    case "add-source":
      return `I'm working on ${project}. Help me capture a source: ask me for a URL, PDF, or vault note, then import it with research_source_import so it is captured, enriched, and indexed.`;
    case "create-evidence":
      return `I'm working on ${project}. Read the project's sources with note_read and extract a precise passage into a reviewable evidence card with research_evidence_capture.`;
    case "create-claim":
      return `I'm working on ${project}. Review the evidence and draft the first claim with research_claim_create, linking its supporting evidence.`;
    case "build-outline":
      return `I'm working on ${project}. Build the evidence-backed outline with research_outline_generate from the reviewed claims.`;
    case "continue-outline":
      return `I'm working on ${project}. Continue the draft from the outline, keeping every section grounded in its claims.`;
    case "assure-document":
      return `I'm working on ${project}. Run research_audit, walk me through the findings, and help me fix them.`;
    case "open-question":
      return `I'm working on ${project}. Help me answer this open research question${record}: search my vault and the web, then capture what you find as sources and evidence.`;
    case "challenged-claim":
      return `I'm working on ${project}. The claim${record} has challenging evidence — help me respond to it explicitly.`;
    case "unverifiable-source":
    case "stale-evidence":
    case "broken-reference":
    case "invalid-record":
    case "rejected-claim":
    case "unsupported-claim":
    case "missing-locator":
    case "review-claim":
    case "review-evidence":
      return `I'm working on ${project}. Run research_audit, then fix this finding: ${action.label}${record}. ${action.reason}`;
    default:
      return `I'm working on ${project}. Next step: ${action.label}. ${action.reason}`;
  }
}
