import { describe, expect, it, vi } from "vitest";
import { UtilityFallbackConsent, type ConsentDialog } from "../../src/providers/utilityConsent";
import type { UtilityFallbackApproval } from "../../src/providers/endpointPolicy";
import type { UtilityFallbackConsentContext } from "../../src/providers/router";

const identity = {};
const context = (fingerprint = "ollama@127.0.0.1→anthropic", id: object = identity): UtilityFallbackConsentContext => ({
  identity: id,
  destinationFingerprint: fingerprint,
  configuredBackend: "ollama",
  configuredEndpoint: "http://127.0.0.1:11434",
  fallbackProvider: "anthropic",
  fallbackEndpoint: "https://api.anthropic.com",
});

function dialogs({ closeAnswers = true } = {}) {
  const opened: Array<{ context: UtilityFallbackConsentContext; choose(choice: UtilityFallbackApproval): void; close: ReturnType<typeof vi.fn> }> = [];
  const ask = (ctx: UtilityFallbackConsentContext): ConsentDialog => {
    let choose!: (choice: UtilityFallbackApproval) => void;
    const decision = new Promise<UtilityFallbackApproval>((resolve) => { choose = resolve; });
    const close = vi.fn(() => { if (closeAnswers) choose("deny"); });
    opened.push({ context: ctx, choose, close });
    return { decision, close };
  };
  return { opened, ask };
}

describe("UtilityFallbackConsent", () => {
  it("asks once and caches the decision for the same context", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context());
    opened[0]!.choose("allow");
    await expect(first).resolves.toBe("allow");
    await expect(consent.decide(context())).resolves.toBe("allow");
    expect(consent.current(context())).toBe("allow");
    expect(opened).toHaveLength(1);
  });

  it("shares one open dialog between concurrent callers for the same context", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const a = consent.decide(context());
    const b = consent.decide(context());
    opened[0]!.choose("allow");
    await expect(Promise.all([a, b])).resolves.toEqual(["allow", "allow"]);
    expect(opened).toHaveLength(1);
  });

  it("closes a stale dialog when a different destination asks", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const stale = consent.decide(context("old"));
    const fresh = consent.decide(context("new"));
    expect(opened[0]!.close).toHaveBeenCalledOnce();
    await expect(stale).resolves.toBe("deny");
    opened[1]!.choose("allow");
    await expect(fresh).resolves.toBe("allow");
    expect(consent.current(context("new"))).toBe("allow");
  });

  it("never lets a racing allow replace a denial for the same context", async () => {
    const { opened, ask } = dialogs({ closeAnswers: false });
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context("a"));
    consent.decide(context("b"));
    const back = consent.decide(context("a"));
    expect(opened.map((d) => d.context.destinationFingerprint)).toEqual(["a", "b", "a"]);
    opened[0]!.choose("deny");
    await expect(first).resolves.toBe("deny");
    opened[2]!.choose("allow");
    await expect(back).resolves.toBe("deny");
    expect(consent.current(context("a"))).toBe("deny");
  });

  it("answers deny for every dialog superseded by another destination", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const a = consent.decide(context("a"));
    const b = consent.decide(context("b"));
    const latest = consent.decide(context("a"));
    expect(opened[0]!.close).toHaveBeenCalledOnce();
    expect(opened[1]!.close).toHaveBeenCalledOnce();
    await expect(Promise.all([a, b])).resolves.toEqual(["deny", "deny"]);
    opened[2]!.choose("allow");
    await expect(latest).resolves.toBe("allow");
  });

  it("drops a decision made for another context", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context());
    opened[0]!.choose("allow");
    await first;
    expect(consent.current(context("gateway"))).toBeUndefined();
    expect(consent.current(context())).toBeUndefined();
    expect(consent.current(null)).toBeUndefined();
  });

  it("keys on identity as well as fingerprint", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context());
    opened[0]!.choose("allow");
    await first;
    expect(consent.current(context(undefined, {}))).toBeUndefined();
  });

  it("forgets only the matching context", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context());
    opened[0]!.choose("allow");
    await first;
    consent.forget(context("other"));
    expect(consent.current(context())).toBe("allow");
    consent.forget(context());
    expect(consent.current(context())).toBeUndefined();
  });

  it("denies everything once the session ends and closes the open dialog", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const pending = consent.decide(context());
    consent.end();
    expect(opened[0]!.close).toHaveBeenCalledOnce();
    await expect(pending).resolves.toBe("deny");
    await expect(consent.decide(context())).resolves.toBe("deny");
    expect(opened).toHaveLength(1);
    expect(consent.current(context())).toBeUndefined();
  });

  it("asks again for a context whose decision was dropped", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context("a"));
    opened[0]!.choose("allow");
    await first;
    expect(consent.current(context("b"))).toBeUndefined();
    const again = consent.decide(context("a"));
    expect(opened).toHaveLength(2);
    opened[1]!.choose("deny");
    await expect(again).resolves.toBe("deny");
  });

  it("drops a cached decision when the session ends", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context());
    opened[0]!.choose("allow");
    await first;
    consent.end();
    expect(consent.current(context())).toBeUndefined();
  });

  it("starts a session with no decision, no open dialog, and asking enabled", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const first = consent.decide(context("a"));
    opened[0]!.choose("allow");
    await first;
    consent.start();
    expect(consent.current(context("a"))).toBeUndefined();
    consent.decide(context("b"));
    consent.end();
    consent.start();
    consent.decide(context("b"));
    expect(opened).toHaveLength(3);
    consent.start();
    consent.decide(context("b"));
    expect(opened).toHaveLength(4);
  });

  it("ignores an allow from a dialog opened in an earlier session", async () => {
    const { opened, ask } = dialogs();
    const consent = new UtilityFallbackConsent(ask);
    const old = consent.decide(context());
    consent.start();
    opened[0]!.choose("allow");
    await expect(old).resolves.toBe("deny");
    expect(consent.current(context())).toBeUndefined();
    const next = consent.decide(context());
    opened[1]!.choose("allow");
    await expect(next).resolves.toBe("allow");
  });
});
