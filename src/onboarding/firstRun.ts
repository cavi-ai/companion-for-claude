// Ordering for the one-time consent prompts a fresh install fires. Pure; the
// plugin's layout-ready path and the connect card both key off this.

export type FirstRunPrompt = "ontology" | "semantic" | "integrations";

export interface FirstRunState {
  /** True while chat would fail for want of a credential (see setupState.ts). */
  needsCredential: boolean;
  /** Ontology is on and its seed offer has not been made yet. */
  ontologyPending: boolean;
  /** Semantic search is on, engine is built-in, and the download offer is unmade. */
  semanticPending: boolean;
  /** Desktop, and the desktop-integrations offer has not been made yet. */
  integrationsPending: boolean;
}

/**
 * Which optional prompts may open now, in order. Empty while the user has no
 * credential: a modal asking to seed schemas or fetch model weights before the
 * plugin can chat at all buries the one step that matters, and each prompt is
 * one-shot — a dismissal there is spent for good.
 */
export function pendingFirstRunPrompts(s: FirstRunState): FirstRunPrompt[] {
  if (s.needsCredential) return [];
  const pending: FirstRunPrompt[] = [];
  // Ontology first: a consent dialog costs nothing, the download is ~100 MB.
  if (s.ontologyPending) pending.push("ontology");
  if (s.semanticPending) pending.push("semantic");
  // Integrations last: it opens a modal with its own setup flow.
  if (s.integrationsPending) pending.push("integrations");
  return pending;
}
