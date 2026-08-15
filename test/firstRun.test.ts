import { describe, it, expect } from "vitest";
import { pendingFirstRunPrompts, type FirstRunState } from "../src/onboarding/firstRun";

const state = (over: Partial<FirstRunState> = {}): FirstRunState => ({
  needsCredential: false,
  ontologyPending: false,
  semanticPending: false,
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
});
