import { App, Modal, clearNotices, getNoticeMessages, type FakeElement } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding, type OnboardingDeps } from "../../src/onboarding/onboarding";
import type { OntologyRegistry } from "../../src/ontology/registry";
import type { ProviderRouter } from "../../src/providers/router";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { ChoiceModal } from "../../src/view/ChoiceModal";

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
    openConnection: vi.fn(),
    isMobile: () => over.mobile ?? false,
  };
  return { app, settings, ontology, calls, saveSettings, semantic, openDesktopIntegrations, router, onboarding: new Onboarding(deps) };
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

describe("first use without setup interruptions", () => {
  it("loads existing schemas after the probe without opening setup or optional prompts", async () => {
    const opened = vi.spyOn(Modal.prototype, "open");
    const { onboarding, ontology, semantic, openDesktopIntegrations } = setup();
    await onboarding.runFirstRun();
    expect(ontology!.load).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    expect(semantic.promptSemanticModelIfNeeded).not.toHaveBeenCalled();
    expect(openDesktopIntegrations).not.toHaveBeenCalled();
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
