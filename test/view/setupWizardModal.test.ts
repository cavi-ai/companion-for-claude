import { App, FakeElement } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { SetupWizardModal, type SetupWizardDependencies } from "../../src/view/SetupWizardModal";

const deps = (over: Partial<SetupWizardDependencies> = {}): SetupWizardDependencies => ({
  steps: ["connect", "vault-tools", "index"],
  storageBlurb: "Stored locally.",
  cliAvailable: false,
  cliSignedIn: false,
  hasCredential: () => false,
  useClaudeCli: vi.fn().mockResolvedValue(undefined),
  saveApiKey: vi.fn().mockResolvedValue({ ok: true }),
  ollamaHostDefault: "http://localhost:11434",
  useLocal: vi.fn().mockResolvedValue(undefined),
  connectVaultTools: vi.fn(),
  agentAllowWrites: true,
  setAgentAllowWrites: vi.fn().mockResolvedValue(undefined),
  semanticPending: true,
  ontologyPending: true,
  downloadEmbeddings: vi.fn().mockResolvedValue(undefined),
  seedOntology: vi.fn().mockResolvedValue(undefined),
  finish: vi.fn().mockResolvedValue(undefined),
  onClosed: vi.fn(),
  ...over,
});

const root = (modal: SetupWizardModal) => modal.contentEl as unknown as FakeElement;
const button = (modal: SetupWizardModal, text: string) => root(modal).querySelectorAll("button").find((b) => b.textContent === text);

describe("SetupWizardModal", () => {
  it("renders only the planned steps in the stepper", () => {
    const modal = new SetupWizardModal(new App(), deps({ steps: ["connect", "index"] }));
    modal.onOpen();
    expect(root(modal).querySelector(".cc-wizard-stepper")?.textContent).toBe("1 Connect · 2 Index");
    expect(root(modal).querySelector(".cc-wizard-connect-tools")).toBeNull();
  });

  it("shows only the steps passed in, e.g. vault-tools alone", () => {
    const modal = new SetupWizardModal(new App(), deps({ steps: ["vault-tools"] }));
    modal.onOpen();
    expect(root(modal).querySelector(".cc-wizard-stepper")?.textContent).toBe("1 Vault tools");
    expect(root(modal).querySelector(".cc-wizard-connect-tools")).not.toBeNull();
  });

  it("advances on a saved API key and Back returns to the connect step", async () => {
    const saveApiKey = vi.fn().mockResolvedValue({ ok: true });
    const modal = new SetupWizardModal(new App(), deps({ steps: ["connect", "index"], saveApiKey }));
    modal.onOpen();
    const input = root(modal).querySelector(".cc-setup-input") as FakeElement;
    input.value = "sk-ant-test";
    button(modal, "Save key")?.dispatchEvent({ type: "click" });
    await Promise.resolve();
    await Promise.resolve();
    expect(saveApiKey).toHaveBeenCalledWith("sk-ant-test");
    // Now on step 2 ("index") — Back button is present.
    expect(root(modal).querySelector(".cc-setup-title")?.textContent).toBe("Index your vault");
    button(modal, "Back")?.dispatchEvent({ type: "click" });
    expect(root(modal).querySelector(".cc-setup-title")?.textContent).toBe("Connect to Claude");
  });

  it("disables Skip on the connect step without a credential", () => {
    const modal = new SetupWizardModal(new App(), deps({ steps: ["connect", "index"], hasCredential: () => false }));
    modal.onOpen();
    expect(button(modal, "Skip")?.disabled).toBe(true);
  });

  it("enables Skip on the connect step once a credential exists", () => {
    const modal = new SetupWizardModal(new App(), deps({ steps: ["connect", "index"], hasCredential: () => true }));
    modal.onOpen();
    expect(button(modal, "Skip")?.disabled).toBe(false);
  });

  it("labels the last step's advance button Finish and persists on click", () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const modal = new SetupWizardModal(new App(), deps({ steps: ["index"], finish }));
    modal.onOpen();
    expect(button(modal, "Next")).toBeUndefined();
    button(modal, "Finish")?.dispatchEvent({ type: "click" });
    expect(finish).toHaveBeenCalled();
    expect(modal.closed).toBe(true);
  });

  it("Skip on the last step also finishes (dismiss == finish)", () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const modal = new SetupWizardModal(new App(), deps({ steps: ["vault-tools"], finish }));
    modal.onOpen();
    button(modal, "Skip")?.dispatchEvent({ type: "click" });
    expect(finish).toHaveBeenCalled();
  });
});
