import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_DEFAULT_BASE_URL } from "../../src/providers/auth";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import type { ProviderRouter, RuntimeUtilitySelection, UtilityFallbackConsentContext } from "../../src/providers/router";
import { UtilityRouting } from "../../src/providers/utilityRouting";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { ChoiceModal } from "../../src/view/ChoiceModal";
import type { FakeElement } from "../fakes/obsidian";

afterEach(() => vi.restoreAllMocks());

const ENDPOINT = "http://localhost:11434";

function consentContext(identity: object, fingerprint = "fp"): UtilityFallbackConsentContext {
  return {
    identity,
    destinationFingerprint: fingerprint,
    configuredBackend: "ollama",
    configuredEndpoint: ENDPOINT,
    fallbackProvider: "anthropic",
    fallbackEndpoint: ANTHROPIC_DEFAULT_BASE_URL,
  };
}

const loopback = { state: "unavailable-loopback", backend: "ollama", endpoint: ENDPOINT } as unknown as RuntimeUtilitySelection;
const configured = {
  state: "configured-provider", backend: "ollama", endpoint: ENDPOINT, model: "m1", provider: { id: "ollama", label: "Ollama" },
} as unknown as RuntimeUtilitySelection;
const approved = {
  state: "approved-Claude-fallback", backend: "ollama", endpoint: ENDPOINT, model: "claude-x", provider: { id: "anthropic", label: "Claude" },
} as unknown as RuntimeUtilitySelection;
const denied = { state: "unavailable-without-Claude", backend: "ollama", endpoint: ENDPOINT, reason: "fallback-not-approved" } as unknown as RuntimeUtilitySelection;

interface RouterFake {
  utilityFallbackConsentContext: ReturnType<typeof vi.fn>;
  resolveUtilityForRuntime: ReturnType<typeof vi.fn>;
}

function fakeRouter(over: Partial<RouterFake> = {}): RouterFake {
  const identity = {};
  return {
    utilityFallbackConsentContext: vi.fn(() => consentContext(identity)),
    resolveUtilityForRuntime: vi.fn((input: { fallbackApproval?: string }) =>
      input.fallbackApproval === "allow" ? approved : input.fallbackApproval === "deny" ? denied : loopback),
    ...over,
  };
}

function routing(routerFake: RouterFake, settings: Partial<PluginSettings> = {}, isMobile = true): UtilityRouting {
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...settings };
  const r = new UtilityRouting({
    app: new App(),
    settings: () => merged,
    router: () => routerFake as unknown as ProviderRouter,
    isMobile: () => isMobile,
  });
  r.start();
  return r;
}

function captureModal(): { last: () => ChoiceModal<string>; choose: (label: string) => void } {
  const real = ChoiceModal.prototype.open;
  const open = vi.spyOn(ChoiceModal.prototype, "open").mockImplementation(function (this: ChoiceModal<string>) {
    real.call(this);
  });
  const last = (): ChoiceModal<string> => open.mock.contexts.at(-1) as ChoiceModal<string>;
  return {
    last,
    choose: (label) => {
      const button = (last().contentEl as unknown as FakeElement).querySelectorAll("button").find((b) => b.textContent === label);
      button!.dispatchEvent({ type: "click" });
    },
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe("UtilityRouting.resolveSession", () => {
  it("returns a configured provider without prompting", async () => {
    const router = fakeRouter({ utilityFallbackConsentContext: vi.fn(() => null), resolveUtilityForRuntime: vi.fn(() => configured) });
    const opened = vi.spyOn(ChoiceModal.prototype, "open");
    await expect(routing(router).resolveSession()).resolves.toBe(configured);
    expect(opened).not.toHaveBeenCalled();
    expect(router.resolveUtilityForRuntime).toHaveBeenCalledWith({ isMobile: true });
  });

  it("fails closed when the loopback endpoint has no fallback context to approve", async () => {
    const router = fakeRouter({ utilityFallbackConsentContext: vi.fn(() => null) });
    await expect(routing(router).resolveSession()).rejects.toBeInstanceOf(UtilityUnavailableError);
  });

  it("prompts on a mobile loopback endpoint and applies an allow decision", async () => {
    const router = fakeRouter();
    const modal = captureModal();
    const pending = routing(router).resolveSession();
    await settle();
    expect((modal.last().contentEl as unknown as FakeElement).querySelector("p")?.textContent).toContain(ENDPOINT);
    modal.choose("Use Claude this session");
    await expect(pending).resolves.toBe(approved);
    expect(router.resolveUtilityForRuntime).toHaveBeenLastCalledWith({ isMobile: true, fallbackApproval: "allow" });
  });

  it("rejects with the not-approved message when the user declines", async () => {
    const modal = captureModal();
    const pending = routing(fakeRouter()).resolveSession();
    await settle();
    modal.choose("Don't send");
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UtilityUnavailableError);
    expect((error as Error).message).toContain("was not approved for this session");
  });

  it("names the current fallback endpoint when the destination changed during approval", async () => {
    let current = consentContext({});
    const router = fakeRouter({ utilityFallbackConsentContext: vi.fn(() => current) });
    const modal = captureModal();
    const pending = routing(router).resolveSession();
    await settle();
    current = consentContext({}, "other-gateway");
    modal.choose("Use Claude this session");
    await expect(pending).rejects.toThrow(/destination changed while fallback approval was open/);
  });

  it("rejects approval granted for settings that changed to a configured backend", async () => {
    let current = consentContext({});
    let swapped = false;
    const router = fakeRouter({
      utilityFallbackConsentContext: vi.fn(() => current),
      resolveUtilityForRuntime: vi.fn(() => (swapped ? configured : loopback)),
    });
    const modal = captureModal();
    const pending = routing(router).resolveSession();
    await settle();
    swapped = true;
    current = consentContext({}, "other-gateway");
    modal.choose("Use Claude this session");
    await expect(pending).rejects.toThrow(/Utility settings changed while Claude fallback approval was open.*ollama utility backend is http:\/\/localhost:11434/);
  });

  it("discards the result when the plugin unloads while the approval is open", async () => {
    const modal = captureModal();
    const r = routing(fakeRouter());
    const pending = r.resolveSession();
    await settle();
    r.end();
    expect((modal.last() as unknown as { closed: boolean }).closed).toBe(true);
    await expect(pending).rejects.toThrow("Companion unloaded before utility approval completed; no content was sent.");
  });

  it("refuses new work after the session ended", async () => {
    const r = routing(fakeRouter());
    r.end();
    await expect(r.resolveSession()).rejects.toThrow("Companion unloaded before utility approval completed; no content was sent.");
  });

  it("reuses an allow decision for the same destination without prompting again", async () => {
    const router = fakeRouter();
    const modal = captureModal();
    const r = routing(router);
    const first = r.resolveSession();
    await settle();
    modal.choose("Use Claude this session");
    await first;
    const open = vi.mocked(ChoiceModal.prototype.open);
    open.mockClear();
    await expect(r.resolveSession()).resolves.toBe(approved);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("UtilityRouting lifecycle", () => {
  it("invalidates the generation on end and on a restart", () => {
    const r = routing(fakeRouter());
    const first = r.lifecycleGeneration();
    expect(r.isLifecycleActive(first)).toBe(true);
    r.end();
    expect(r.isEnded()).toBe(true);
    expect(r.isLifecycleActive(first)).toBe(false);
    expect(() => r.assertLifecycleActive(first)).toThrow("Companion unloaded while utility work was in flight; the result was discarded without writing.");
    r.start();
    expect(r.isEnded()).toBe(false);
    expect(r.lifecycleGeneration()).toBeGreaterThan(first);
    expect(r.isLifecycleActive(first)).toBe(false);
    expect(r.isLifecycleActive(r.lifecycleGeneration())).toBe(true);
    expect(() => r.assertLifecycleActive(r.lifecycleGeneration())).not.toThrow();
  });
});

describe("UtilityRouting.backendLabel", () => {
  const labelFor = (selection: RuntimeUtilitySelection): string =>
    routing(fakeRouter({ resolveUtilityForRuntime: vi.fn(() => selection), utilityFallbackConsentContext: vi.fn(() => null) })).backendLabel();

  it("describes each runtime selection", () => {
    expect(labelFor(loopback)).toBe("Unavailable on mobile · Claude approval required");
    expect(labelFor({ ...denied, reason: "invalid-endpoint" } as unknown as RuntimeUtilitySelection)).toBe("Unavailable · invalid utility endpoint");
    expect(labelFor(denied)).toBe("Unavailable on mobile");
    expect(labelFor(approved)).toBe("Claude (Anthropic API) · claude-x");
    expect(labelFor(configured)).toBe("Ollama · m1");
    expect(labelFor({ ...configured, provider: { id: "openai-compat", label: "Custom" } } as unknown as RuntimeUtilitySelection)).toBe("OpenAI-compatible endpoint · m1");
  });
});

describe("UtilityRouting error hints", () => {
  const hint = (selection: RuntimeUtilitySelection, settings: Partial<PluginSettings>): string | null =>
    routing(fakeRouter({ resolveUtilityForRuntime: vi.fn(() => selection), utilityFallbackConsentContext: vi.fn(() => null) }), settings)
      .enrichmentErrorHint("failed to fetch");

  it("attributes a failure to the selected provider's configured endpoint", () => {
    expect(hint(configured, { ollamaHost: "http://10.0.0.5:11434" })).toContain("10.0.0.5:11434");
    expect(hint({ ...configured, provider: { id: "openai-compat", label: "Custom" } } as unknown as RuntimeUtilitySelection, { openaiCompatHost: "https://models.example.com" }))
      .toContain("OpenAI-compatible endpoint at https://models.example.com");
  });

  it("falls back to the configured backend when no provider is selected", () => {
    expect(hint(denied, { ollamaHost: "http://10.0.0.5:11434" })).toContain("10.0.0.5:11434");
    expect(hint({ ...denied, backend: "custom" } as unknown as RuntimeUtilitySelection, { openaiCompatHost: "https://models.example.com" }))
      .toContain("https://models.example.com");
  });
});

describe("UtilityRouting.unavailableMessage", () => {
  const message = (selection: Record<string, unknown>): string =>
    routing(fakeRouter()).unavailableMessage({ endpoint: ENDPOINT, backend: "ollama", ...selection } as never);

  it("explains every unavailable state", () => {
    expect(message({ state: "unavailable-loopback" })).toContain("is unavailable on mobile until Claude fallback is approved");
    expect(message({ state: "unavailable-without-Claude", reason: "invalid-endpoint" })).toContain("is invalid");
    expect(message({ state: "unavailable-without-Claude", reason: "mobile-local-endpoint" })).toContain("is local to this device");
    expect(message({ state: "unavailable-without-Claude", reason: "claude-unavailable", backend: "claude" })).toContain("no Anthropic credential is configured. Add a credential");
    expect(message({ state: "unavailable-without-Claude", reason: "claude-unavailable" })).toContain("no Anthropic credential is configured for Claude fallback");
    expect(message({ state: "unavailable-without-Claude", reason: "fallback-not-approved" })).toContain("was not approved for this session");
    expect(message({ state: "unavailable-without-Claude", reason: "invalid-endpoint", endpoint: "" })).toContain("“(empty endpoint)”");
  });
});
