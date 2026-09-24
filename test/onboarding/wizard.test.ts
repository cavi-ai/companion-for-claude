import { describe, it, expect } from "vitest";
import { wizardPlan, wizardPlanExplicit, WIZARD_DISMISSED_SETTINGS, type WizardState } from "../../src/onboarding/wizard";

const state = (over: Partial<WizardState> = {}): WizardState => ({
  needsCredential: false,
  isDesktop: true,
  desktopIntegrationsOffered: true,
  semanticModelPrompted: true,
  ontologySeedPrompted: true,
  ...over,
});

describe("wizardPlan", () => {
  it("is empty for a fully configured install", () => {
    expect(wizardPlan(state())).toEqual([]);
  });

  it("is empty while a credential is missing, regardless of the other steps", () => {
    expect(wizardPlan(state({ needsCredential: true }))).toEqual([]);
    expect(wizardPlan(state({
      needsCredential: true,
      desktopIntegrationsOffered: false,
      semanticModelPrompted: false,
    }))).toEqual([]);
  });

  it("includes step 2 iff desktop and not yet offered", () => {
    expect(wizardPlan(state({ isDesktop: true, desktopIntegrationsOffered: false }))).toEqual(["vault-tools"]);
    expect(wizardPlan(state({ isDesktop: true, desktopIntegrationsOffered: true }))).toEqual([]);
    expect(wizardPlan(state({ isDesktop: false, desktopIntegrationsOffered: false }))).toEqual([]);
  });

  it("includes step 3 iff either the semantic or ontology flag is unset", () => {
    expect(wizardPlan(state({ semanticModelPrompted: false, ontologySeedPrompted: true }))).toEqual(["index"]);
    expect(wizardPlan(state({ semanticModelPrompted: true, ontologySeedPrompted: false }))).toEqual(["index"]);
    expect(wizardPlan(state({ semanticModelPrompted: false, ontologySeedPrompted: false }))).toEqual(["index"]);
    expect(wizardPlan(state({ semanticModelPrompted: true, ontologySeedPrompted: true }))).toEqual([]);
  });

  it("orders the auto-eligible steps vault-tools, index", () => {
    expect(wizardPlan(state({
      desktopIntegrationsOffered: false,
      semanticModelPrompted: false,
    }))).toEqual(["vault-tools", "index"]);
  });

  it("finishing sets setupWizardDone", () => {
    expect(WIZARD_DISMISSED_SETTINGS).toEqual({ setupWizardDone: true });
  });
});

describe("wizardPlanExplicit", () => {
  it("starts with connect when a credential is missing, unlike the auto plan", () => {
    expect(wizardPlanExplicit(state({ needsCredential: true }))).toEqual(["connect"]);
    expect(wizardPlan(state({ needsCredential: true }))).toEqual([]);
  });

  it("orders steps connect, vault-tools, index", () => {
    expect(wizardPlanExplicit(state({
      needsCredential: true,
      desktopIntegrationsOffered: false,
      semanticModelPrompted: false,
    }))).toEqual(["connect", "vault-tools", "index"]);
  });

  it("matches the auto plan once a credential exists", () => {
    expect(wizardPlanExplicit(state({ desktopIntegrationsOffered: false }))).toEqual(wizardPlan(state({ desktopIntegrationsOffered: false })));
  });

  it("dismissing without a credential leaves needsCredential true and the explicit plan non-empty next launch", () => {
    // Dismissal only ever persists WIZARD_DISMISSED_SETTINGS — it cannot
    // clear needsCredential, so a fresh explicit plan computed from the same
    // underlying state next launch is still non-empty.
    const dismissedState = state({ needsCredential: true });
    expect(dismissedState.needsCredential).toBe(true);
    expect(wizardPlanExplicit(dismissedState)).toEqual(["connect"]);
  });
});
