import { describe, it, expect } from "vitest";
import { pendingFirstRunPrompts, type FirstRunState } from "../src/onboarding/firstRun";

const state = (over: Partial<FirstRunState> = {}): FirstRunState => ({
  needsCredential: false,
  ontologyPending: false,
  semanticPending: false,
  integrationsPending: false,
  ...over,
});

describe("pendingFirstRunPrompts", () => {
  it("holds every optional prompt back while the user has no credential", () => {
    expect(pendingFirstRunPrompts(state({ needsCredential: true, ontologyPending: true, semanticPending: true })))
      .toEqual([]);
  });

  it("releases the pending prompts once a credential exists", () => {
    expect(pendingFirstRunPrompts(state({ ontologyPending: true, semanticPending: true })))
      .toEqual(["ontology", "semantic"]);
  });

  it("returns only what is actually pending", () => {
    expect(pendingFirstRunPrompts(state({ semanticPending: true }))).toEqual(["semantic"]);
    expect(pendingFirstRunPrompts(state({ ontologyPending: true }))).toEqual(["ontology"]);
  });

  it("returns nothing when both features are off or already prompted", () => {
    expect(pendingFirstRunPrompts(state())).toEqual([]);
  });

  it("orders ontology before semantic — the cheap consent precedes the download", () => {
    expect(pendingFirstRunPrompts(state({ ontologyPending: true, semanticPending: true })))
      .toEqual(["ontology", "semantic"]);
  });

  it("offers desktop integrations last, after both consents", () => {
    expect(pendingFirstRunPrompts(state({ ontologyPending: true, semanticPending: true, integrationsPending: true })))
      .toEqual(["ontology", "semantic", "integrations"]);
  });

  it("holds the integrations offer back without a credential", () => {
    expect(pendingFirstRunPrompts(state({ needsCredential: true, integrationsPending: true }))).toEqual([]);
  });

  it("offers integrations alone once the consents are spent", () => {
    expect(pendingFirstRunPrompts(state({ integrationsPending: true }))).toEqual(["integrations"]);
  });
});
