// First-run setup wizard: a pure 3-step state machine over the same
// persisted flags `firstRun.ts` already orders. No new migration — a step is
// in the plan only while it still has something to decide.

export type WizardStep = "connect" | "vault-tools" | "index";

export interface WizardState {
  /** True while chat would fail for want of a credential (see setupState.ts). */
  needsCredential: boolean;
  /** Desktop only: the "Connect vault tools to Claude Code" flow applies. */
  isDesktop: boolean;
  /** Desktop-integrations offer already made (own flag; step 2 folds it in). */
  desktopIntegrationsOffered: boolean;
  /** Built-in embeddings download prompt already made. */
  semanticModelPrompted: boolean;
  /** Ontology seed prompt already made. */
  ontologySeedPrompted: boolean;
}

/** Steps 2 and 3 — never gated on a credential, in display order. */
function postConnectSteps(state: WizardState): WizardStep[] {
  const steps: WizardStep[] = [];
  if (state.isDesktop && !state.desktopIntegrationsOffered) steps.push("vault-tools");
  if (!state.semanticModelPrompted || !state.ontologySeedPrompted) steps.push("index");
  return steps;
}

/**
 * Which wizard steps may open on their own (layout-ready, or once a credential
 * is saved), in display order. Empty while a credential is missing, mirroring
 * `pendingFirstRunPrompts` — the chat setup card is the only step 1 until then.
 */
export function wizardPlan(state: WizardState): WizardStep[] {
  return state.needsCredential ? [] : postConnectSteps(state);
}

/**
 * Full plan for the explicit "Open setup wizard" command, which the user
 * asked for directly — unlike `wizardPlan`, it includes the connect step
 * when a credential is still missing.
 */
export function wizardPlanExplicit(state: WizardState): WizardStep[] {
  const steps: WizardStep[] = [];
  if (state.needsCredential) steps.push("connect");
  steps.push(...postConnectSteps(state));
  return steps;
}

/**
 * Settings both Finish and Skip/close persist: the wizard doesn't reopen on
 * its own next launch. A dismissal without a credential does not lie about
 * still needing one — `wizardPlan` is unaffected, so the chat setup card
 * keeps covering that gap.
 */
export const WIZARD_DISMISSED_SETTINGS = { setupWizardDone: true } as const;
