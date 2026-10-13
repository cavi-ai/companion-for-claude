import { App, clearNotices, getNoticeMessages, type FakeElement } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding, type OnboardingDeps } from "../../src/onboarding/onboarding";
import type { OntologyRegistry } from "../../src/ontology/registry";
import type { ProviderRouter } from "../../src/providers/router";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { ChoiceModal } from "../../src/view/ChoiceModal";
import { SetupWizardModal, type SetupWizardDependencies } from "../../src/view/SetupWizardModal";

beforeEach(() => clearNotices());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface RouterOpts {
  backend?: string;
  anthropic?: boolean;
  claudeCli?: boolean;
  codexCli?: boolean;
  opencodeCli?: boolean;
  test?: () => Promise<{ ok: boolean; detail: string }>;
}

function fakeRouter(o: RouterOpts = {}): ProviderRouter {
  return {
    chatBackend: o.backend ?? "claude",
    anthropic: { hasCredentials: () => o.anthropic ?? true, test: o.test ?? (async () => ({ ok: true, detail: "" })) },
    claudeCli: { hasCredentials: () => o.claudeCli ?? false, available: () => o.claudeCli ?? false },
    codexCli: { hasCredentials: () => o.codexCli ?? false },
    opencodeCli: { hasCredentials: () => o.opencodeCli ?? false },
  } as unknown as ProviderRouter;
}

function fakeOntology(over: { resolvedSize?: number; errors?: unknown[] } = {}) {
  return {
    load: vi.fn(async () => ({ errors: over.errors ?? [] })),
    resolved: () => new Map(Array.from({ length: over.resolvedSize ?? 0 }, (_, i) => [String(i), {}])),
  };
}

function setup(over: { settings?: Partial<PluginSettings>; router?: RouterOpts; mobile?: boolean; ontology?: ReturnType<typeof fakeOntology> | null } = {}) {
  const app = new App();
  const settings: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), ...over.settings };
  const ontology = over.ontology === undefined ? fakeOntology() : over.ontology;
  const calls: string[] = [];
  const saveSettings = vi.fn(async () => { calls.push("save"); });
  const semantic = {
    promptSemanticModelIfNeeded: vi.fn(async () => { calls.push("semantic-prompt"); }),
    downloadBuiltinModelAndIndex: vi.fn(async () => { calls.push("download"); }),
  };
  const openDesktopIntegrations = vi.fn();
  const router = fakeRouter(over.router);
  const deps: OnboardingDeps = {
    app,
    settings: () => settings,
    saveSettings,
    router: () => router,
    secrets: () => ({ available: () => true }) as never,
    ontology: () => ontology as unknown as OntologyRegistry | null,
    semantic: () => semantic as never,
    openDesktopIntegrations,
    isMobile: () => over.mobile ?? false,
  };
  return { app, settings, ontology, calls, saveSettings, semantic, openDesktopIntegrations, router, onboarding: new Onboarding(deps) };
}

/** Index and vault-tools steps are decided already, so only the connect step can vary. */
const quiet: Partial<PluginSettings> = { semanticEnabled: false, ontologyEnabled: false, desktopIntegrationsOffered: true };

function captureWizards(): { opened: () => SetupWizardDependencies[]; open: ReturnType<typeof vi.spyOn> } {
  const deps: SetupWizardDependencies[] = [];
  const open = vi.spyOn(SetupWizardModal.prototype, "open").mockImplementation(function (this: SetupWizardModal) {
    deps.push((this as unknown as { deps: SetupWizardDependencies }).deps);
  });
  return { opened: () => deps, open };
}

function captureChoice(): { choose: (label: string) => void; open: ReturnType<typeof vi.spyOn> } {
  const real = ChoiceModal.prototype.open;
  const open = vi.spyOn(ChoiceModal.prototype, "open").mockImplementation(function (this: ChoiceModal<string>) {
    real.call(this);
  });
  return {
    open,
    choose: (label) => ((open.mock.contexts.at(-1) as ChoiceModal<string>).contentEl as unknown as FakeElement).querySelectorAll("button").find((b) => b.textContent === label)!.dispatchEvent({ type: "click" }),
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe("Onboarding.runFirstRun", () => {
  it("waits for the CLI probe, then loads the ontology, then continues onboarding", async () => {
    const wizard = captureWizards();
    const { onboarding, ontology, calls } = setup({ settings: { desktopIntegrationsOffered: false, semanticEnabled: false } });
    let release!: () => void;
    const probe = new Promise<void>((resolve) => { release = resolve; });
    ontology!.load.mockImplementation(async () => { calls.push("ontology-load"); return { errors: [] }; });

    const running = onboarding.runFirstRun(probe);
    await settle();
    expect(ontology!.load).not.toHaveBeenCalled();
    expect(wizard.open).not.toHaveBeenCalled();

    release();
    await running;
    expect(calls).toEqual(["ontology-load", "save"]);
    expect(wizard.open).toHaveBeenCalledTimes(1);
  });

  it("skips the ontology load while the feature is off", async () => {
    const { onboarding, ontology } = setup({ settings: quiet });
    await onboarding.runFirstRun();
    expect(ontology!.load).not.toHaveBeenCalled();
  });
});

describe("Onboarding.continueOnboarding", () => {
  it("opens the wizard for the steps still pending", async () => {
    const wizard = captureWizards();
    const { onboarding } = setup({ settings: { semanticEnabled: true, ontologyEnabled: false, desktopIntegrationsOffered: false } });
    await onboarding.continueOnboarding();
    expect(wizard.opened()[0]!.steps).toEqual(["vault-tools", "index"]);
  });

  it("opens no wizard while a credential is missing and runs no prompts either", async () => {
    const wizard = captureWizards();
    const choice = captureChoice();
    const { onboarding, semantic } = setup({ router: { anthropic: false } });
    await onboarding.continueOnboarding();
    expect(wizard.open).not.toHaveBeenCalled();
    expect(choice.open).not.toHaveBeenCalled();
    expect(semantic.promptSemanticModelIfNeeded).not.toHaveBeenCalled();
  });

  it("falls back to the one-shot prompts once the wizard was dismissed", async () => {
    const wizard = captureWizards();
    const { onboarding, semantic } = setup({
      settings: { setupWizardDone: true, semanticEnabled: true, ontologyEnabled: false, desktopIntegrationsOffered: true },
    });
    await onboarding.continueOnboarding();
    expect(wizard.open).not.toHaveBeenCalled();
    expect(semantic.promptSemanticModelIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("keeps a single wizard open until it closes", async () => {
    const wizard = captureWizards();
    const { onboarding } = setup({ settings: { semanticEnabled: true, ontologyEnabled: false, desktopIntegrationsOffered: true } });
    await Promise.all([onboarding.continueOnboarding(), onboarding.continueOnboarding()]);
    expect(wizard.open).toHaveBeenCalledTimes(1);
    onboarding.openSetupWizard();
    expect(wizard.open).toHaveBeenCalledTimes(1);
    wizard.opened()[0]!.onClosed();
    onboarding.openSetupWizard();
    expect(wizard.open).toHaveBeenCalledTimes(2);
  });
});

describe("Onboarding.openSetupWizard", () => {
  it("says so when nothing is left to set up", () => {
    const wizard = captureWizards();
    const { onboarding } = setup({ settings: quiet });
    onboarding.openSetupWizard();
    expect(wizard.open).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toEqual(["Nothing left to set up."]);
  });

  it("includes the connect step when a credential is missing", () => {
    const wizard = captureWizards();
    const { onboarding } = setup({ settings: quiet, router: { anthropic: false } });
    onboarding.openSetupWizard();
    expect(wizard.opened()[0]!.steps).toEqual(["connect"]);
  });

  it("spends the vault-tools offer the moment that step is shown", () => {
    captureWizards();
    const { onboarding, settings, saveSettings } = setup({ settings: { ...quiet, desktopIntegrationsOffered: false } });
    onboarding.openSetupWizard();
    expect(settings.desktopIntegrationsOffered).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });
});

describe("Onboarding wizard dependencies", () => {
  function opened(over: Parameters<typeof setup>[0] = {}) {
    const wizard = captureWizards();
    const ctx = setup({ settings: { ...quiet, semanticEnabled: true, ontologyEnabled: true, ...over.settings }, ...over });
    ctx.onboarding.openSetupWizard();
    return { ...ctx, deps: wizard.opened()[0]! };
  }

  it("describes the credential, storage and pending steps from live state", () => {
    const { deps } = opened({ router: { backend: "claude-cli", anthropic: false, claudeCli: true } });
    expect(deps.cliAvailable).toBe(true);
    expect(deps.cliSignedIn).toBe(true);
    expect(deps.hasCredential()).toBe(true);
    expect(deps.storageBlurb).toBe("Stored in your device's secret storage, not in this vault.");
    expect(deps.semanticPending).toBe(true);
    expect(deps.ontologyPending).toBe(true);
    expect(deps.ollamaHostDefault).toBe(DEFAULT_SETTINGS.ollamaHost);
    expect(deps.agentAllowWrites).toBe(DEFAULT_SETTINGS.agentAllowWrites);
  });

  it("reports no credential when neither an API key nor the CLI is usable", () => {
    expect(opened({ router: { anthropic: false } }).deps.hasCredential()).toBe(false);
  });

  it("switches the chat backend to Claude Code", async () => {
    const { deps, settings, saveSettings } = opened();
    await deps.useClaudeCli();
    expect(settings.chatBackend).toBe("claude-cli");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("saves an API key and reports the connection test result", async () => {
    const ok = opened();
    await expect(ok.deps.saveApiKey("sk-1")).resolves.toEqual({ ok: true });
    expect(ok.settings).toMatchObject({ authMode: "apiKey", apiKey: "sk-1" });
    const bad = opened({ router: { test: async () => ({ ok: false, detail: "401" }) } });
    await expect(bad.deps.saveApiKey("sk-2")).resolves.toEqual({ ok: false, detail: "401" });
  });

  it("points chat at a local model host", async () => {
    const { deps, settings } = opened();
    await deps.useLocal("http://10.0.0.2:11434");
    expect(settings).toMatchObject({ chatBackend: "local", ollamaHost: "http://10.0.0.2:11434" });
  });

  it("marks the vault-tools offer spent and opens desktop integrations", () => {
    const { deps, settings, openDesktopIntegrations } = opened();
    settings.desktopIntegrationsOffered = false;
    deps.connectVaultTools();
    expect(settings.desktopIntegrationsOffered).toBe(true);
    expect(openDesktopIntegrations).toHaveBeenCalledTimes(1);
  });

  it("persists the agent write toggle", async () => {
    const { deps, settings } = opened();
    await deps.setAgentAllowWrites(true);
    expect(settings.agentAllowWrites).toBe(true);
  });

  it("saves the prompted flag before the embedding download starts", async () => {
    const { deps, settings, calls } = opened();
    await deps.downloadEmbeddings();
    expect(settings.semanticModelPrompted).toBe(true);
    expect(calls).toEqual(["save", "download"]);
  });

  it("saves the prompted flag, then seeds the ontology", async () => {
    const { deps, settings, ontology, app } = opened();
    await deps.seedOntology();
    expect(settings.ontologySeedPrompted).toBe(true);
    expect(ontology!.load).toHaveBeenCalledTimes(1);
    expect(app.vault.getFiles().length).toBeGreaterThan(0);
  });

  it("finishing persists the dismissal", async () => {
    const { deps, settings, saveSettings } = opened();
    await deps.finish();
    expect(settings.setupWizardDone).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });
});

describe("Onboarding.runFirstRunPrompts", () => {
  it("runs the ontology offer, then the semantic prompt, then the integrations offer", async () => {
    const choice = captureChoice();
    const { onboarding, calls, semantic, openDesktopIntegrations } = setup({
      settings: { ontologyEnabled: true, semanticEnabled: true, desktopIntegrationsOffered: false, setupWizardDone: true },
    });
    semantic.promptSemanticModelIfNeeded.mockImplementation(async () => { calls.push("semantic"); });

    const running = onboarding.runFirstRunPrompts();
    await settle();
    expect(choice.open).toHaveBeenCalledTimes(1);
    choice.choose("Not now");
    await settle();
    expect(calls).toContain("semantic");
    expect(choice.open).toHaveBeenCalledTimes(2);
    choice.choose("Open desktop integrations");
    await running;
    expect(openDesktopIntegrations).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a credential", async () => {
    const choice = captureChoice();
    const { onboarding, semantic } = setup({ router: { anthropic: false }, settings: { setupWizardDone: true } });
    await onboarding.runFirstRunPrompts();
    expect(choice.open).not.toHaveBeenCalled();
    expect(semantic.promptSemanticModelIfNeeded).not.toHaveBeenCalled();
  });
});

describe("Onboarding ontology", () => {
  it("surfaces startup schema errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { onboarding } = setup({ ontology: fakeOntology({ errors: [{ file: "a" }, { file: "b" }] }) });
    await onboarding.loadOntologyOnStart();
    expect(getNoticeMessages()).toEqual(["Ontology has 2 schema errors — check the console."]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the registry is off or clean", async () => {
    await setup({ ontology: null }).onboarding.loadOntologyOnStart();
    await setup().onboarding.loadOntologyOnStart();
    expect(getNoticeMessages()).toEqual([]);
  });

  it("offers the seed once and creates the schemas when accepted", async () => {
    const choice = captureChoice();
    const { onboarding, settings, app, saveSettings } = setup({ settings: { ontologySeedPrompted: false } });
    const offer = onboarding.offerOntologySeed();
    await settle();
    expect(settings.ontologySeedPrompted).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    choice.choose("Create default schemas");
    await offer;
    await settle();
    expect(app.vault.getFiles().some((f) => f.path.startsWith(`${settings.ontologyFolder}/`))).toBe(true);
  });

  it("does not offer when schemas exist, the offer was made, or the registry is off", async () => {
    const choice = captureChoice();
    await setup({ ontology: fakeOntology({ resolvedSize: 2 }) }).onboarding.offerOntologySeed();
    await setup({ settings: { ontologySeedPrompted: true } }).onboarding.offerOntologySeed();
    await setup({ ontology: null }).onboarding.offerOntologySeed();
    expect(choice.open).not.toHaveBeenCalled();
  });

  it("seeds missing schema notes, reports the count, and does nothing the second time", async () => {
    const { onboarding, app, settings, ontology } = setup();
    await onboarding.seedOntology();
    const created = app.vault.getFiles().filter((f) => f.path.startsWith(`${settings.ontologyFolder}/`));
    expect(created.length).toBeGreaterThan(0);
    expect(getNoticeMessages()[0]).toBe(`Ontology: seeded ${created.length} type${created.length === 1 ? "" : "s"} → ${settings.ontologyFolder}/`);
    expect(ontology!.load).toHaveBeenCalledTimes(1);

    clearNotices();
    await onboarding.seedOntology();
    expect(getNoticeMessages()).toEqual(["Ontology already seeded — nothing to do."]);
  });

  it("reports schema errors found after seeding", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { onboarding } = setup({ ontology: fakeOntology({ errors: [{}] }) });
    await onboarding.seedOntology();
    expect(getNoticeMessages().at(-1)).toBe("Ontology has 1 schema error — check the console.");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("debounces reloads and drops the pending one on dispose", async () => {
    vi.useFakeTimers();
    const { onboarding, ontology } = setup();
    onboarding.scheduleOntologyReload();
    await vi.advanceTimersByTimeAsync(300);
    onboarding.scheduleOntologyReload();
    await vi.advanceTimersByTimeAsync(300);
    expect(ontology!.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(ontology!.load).toHaveBeenCalledTimes(1);

    onboarding.scheduleOntologyReload();
    onboarding.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ontology!.load).toHaveBeenCalledTimes(1);
  });
});

describe("Onboarding.offerDesktopIntegrations", () => {
  it("is a no-op on mobile or after the offer was made", async () => {
    const choice = captureChoice();
    await setup({ mobile: true, settings: { desktopIntegrationsOffered: false } }).onboarding.offerDesktopIntegrations();
    await setup({ settings: { desktopIntegrationsOffered: true } }).onboarding.offerDesktopIntegrations();
    expect(choice.open).not.toHaveBeenCalled();
  });

  it("spends the offer and opens the integrations flow when accepted", async () => {
    const choice = captureChoice();
    const { onboarding, settings, openDesktopIntegrations } = setup({ settings: { desktopIntegrationsOffered: false } });
    const offer = onboarding.offerDesktopIntegrations();
    await settle();
    expect(settings.desktopIntegrationsOffered).toBe(true);
    choice.choose("Open desktop integrations");
    await offer;
    expect(openDesktopIntegrations).toHaveBeenCalledTimes(1);
  });

  it("opens nothing when dismissed", async () => {
    const choice = captureChoice();
    const { onboarding, openDesktopIntegrations } = setup({ settings: { desktopIntegrationsOffered: false } });
    const offer = onboarding.offerDesktopIntegrations();
    await settle();
    choice.choose("Not now");
    await offer;
    expect(openDesktopIntegrations).not.toHaveBeenCalled();
  });
});

describe("Onboarding.credentialSetupInputs", () => {
  it("reads the current router", () => {
    const { onboarding } = setup({ router: { backend: "codex-cli", codexCli: true } });
    expect(onboarding.credentialSetupInputs()).toEqual({
      backend: "codex-cli", hasAnthropicCredential: true, hasClaudeCli: false, hasCodexCli: true, hasOpencodeCli: false,
    });
  });
});
