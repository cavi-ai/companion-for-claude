import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";

interface ClipperVerificationHarness {
  queueClipperVerification(file: ReturnType<App["vault"]["seed"]>): void;
  clipperVerificationTimers: Map<string, number>;
}

afterEach(() => vi.useRealTimers());

describe("Clipper first-note verification wiring", () => {
  it("verifies an arriving note and stores only bounded proof metadata", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/Test.md", "A large clipped body that must not be persisted in settings.", {
      frontmatter: { type: "article", schema_version: 1, source: "https://example.com", tags: ["source"] },
    });
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sourceBaseTags = ["source"];
    settings.clipperVerification.article = {
      fingerprint: "fingerprint",
      state: "waiting",
      startedAt: 10,
      mismatches: [],
    };
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app,
      settings,
      persist: async () => undefined,
      clipperVerificationTimers: new Map<string, number>(),
      enrichTimers: new Map<string, number>(),
      enrichRecentlyWritten: new Set<string>(),
      enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      reindexTimer: null,
      _ontologyReloadTimer: null,
      researchRefreshTimer: null,
      inboxBadgeTimer: null,
    });
    const harness = plugin as unknown as ClipperVerificationHarness;

    harness.queueClipperVerification(file);
    await vi.advanceTimersByTimeAsync(600);

    expect(plugin.settings.clipperVerification.article).toMatchObject({
      state: "verified", path: "Clippings/Test.md", mismatches: [],
    });
    expect(JSON.stringify(plugin.settings.clipperVerification)).not.toContain("large clipped body");
    expect(plugin.activity.snapshot().records[0]).toMatchObject({ state: "succeeded", percent: 100 });
    expect(harness.clipperVerificationTimers.size).toBe(0);
  });

  it("cancels pending verification timers on plugin unload", () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/Later.md", "Later");
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.clipperVerification.article = { fingerprint: "x", state: "waiting", startedAt: 1, mismatches: [] };
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app, settings,
      clipperVerificationTimers: new Map<string, number>(),
      enrichTimers: new Map<string, number>(), enrichRecentlyWritten: new Set<string>(), enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
      reindexTimer: null, _ontologyReloadTimer: null, researchRefreshTimer: null, inboxBadgeTimer: null,
    });
    const harness = plugin as unknown as ClipperVerificationHarness;
    harness.queueClipperVerification(file);
    expect(harness.clipperVerificationTimers.size).toBe(1);

    plugin.onunload();

    expect(harness.clipperVerificationTimers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
