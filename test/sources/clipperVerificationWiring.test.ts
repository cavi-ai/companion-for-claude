import { clipperTemplateFor } from "../../src/sources/clipperTemplate";
import { getSchema } from "../../src/sources/registry";
import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import { buildPlugin } from "../fakes/plugin";

afterEach(() => vi.useRealTimers());

function harnessPlugin(app: App, mutate: (settings: typeof DEFAULT_SETTINGS) => void, withPersist = true): ClaudeCompanionPlugin {
  const settings = structuredClone(DEFAULT_SETTINGS);
  mutate(settings);
  return buildPlugin({
    settings,
    ...(withPersist ? { persist: async () => undefined } : {}),
    enrichTimers: new Map<string, number>(),
    enrichRecentlyWritten: new Set<string>(),
    enrichRecentlyWrittenExpiryTimers: new Map<string, number>(),
    reindexTimer: null,
  }, app);
}

describe("Clipper first-note verification wiring", () => {
  it("verifies an arriving note and stores only bounded proof metadata", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/Test.md", "A large clipped body that must not be persisted in settings.", {
      frontmatter: { type: "article", schema_version: 1, clipper_template: clipperTemplateFor(getSchema("article"), { path: "Clippings", tags: ["source"] }).properties.find(({ name }) => name === "clipper_template")!.value, source: "https://example.com", tags: ["source"] },
    });
    const plugin = harnessPlugin(app, (settings) => {
      settings.sourceBaseTags = ["source"];
      settings.clipperVerification.article = {
        fingerprint: "fingerprint",
        state: "waiting",
        startedAt: 10,
        mismatches: [],
      };
    });

    plugin.clipperSetup().queueVerification(file);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600);

    expect(plugin.settings.clipperVerification.article).toMatchObject({
      state: "verified", path: "Clippings/Test.md", mismatches: [],
    });
    expect(JSON.stringify(plugin.settings.clipperVerification)).not.toContain("large clipped body");
    expect(plugin.activity.snapshot().records[0]).toMatchObject({ state: "succeeded", percent: 100 });
  });

  it("reports a frontmatter-less inbox clip instead of waiting forever", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/Raw.md", "{\n\t\"schemaVersion\": \"0.1.0\"\n}\n");
    const plugin = harnessPlugin(app, (settings) => {
      settings.clipperVerification.article = { fingerprint: "fingerprint", state: "waiting", startedAt: 10, mismatches: [] };
    });

    plugin.clipperSetup().queueVerification(file);
    await vi.advanceTimersByTimeAsync(3000);

    expect(plugin.settings.clipperVerification.article).toMatchObject({
      state: "needs-attention",
      path: "Clippings/Raw.md",
      mismatches: [expect.objectContaining({ field: "template" })],
    });
    expect(plugin.activity.snapshot().records[0]).toMatchObject({ state: "needs-attention" });
  });

  it("leaves notes created outside the inbox alone while waiting", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Notes/Scratch.md", "Unrelated note written while waiting.");
    const plugin = harnessPlugin(app, (settings) => {
      settings.clipperVerification.article = { fingerprint: "fingerprint", state: "waiting", startedAt: 10, mismatches: [] };
    });

    plugin.clipperSetup().queueVerification(file);
    await vi.advanceTimersByTimeAsync(3000);

    expect(plugin.settings.clipperVerification.article).toMatchObject({ state: "waiting" });
  });

  it("cancels pending verification timers on plugin unload", () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/Later.md", "Later");
    const plugin = harnessPlugin(app, (settings) => {
      settings.clipperVerification.article = { fingerprint: "x", state: "waiting", startedAt: 1, mismatches: [] };
    }, false);
    plugin.clipperSetup().queueVerification(file);
    expect(vi.getTimerCount()).toBe(1);

    plugin.onunload();

    expect(vi.getTimerCount()).toBe(0);
  });

  function passivePlugin(app: App): ClaudeCompanionPlugin {
    return harnessPlugin(app, (settings) => {
      settings.sourceBaseTags = ["source"];
    });
  }

  it("verifies a stamped clip even when setup was done outside Companion (nothing waiting)", async () => {
    vi.useFakeTimers();
    const app = new App();
    const file = app.vault.seed("Clippings/Stamped.md", "body", {
      frontmatter: { type: "article", schema_version: 1, clipper_template: clipperTemplateFor(getSchema("article"), { path: "Clippings", tags: ["source"] }).properties.find(({ name }) => name === "clipper_template")!.value, source: "https://example.com", tags: ["source"] },
    });
    const plugin = passivePlugin(app);
    expect(plugin.clipperSetup().setupNeeded()).toBe(true);

    plugin.clipperSetup().queueVerification(file);
    await vi.advanceTimersByTimeAsync(600);

    expect(plugin.settings.clipperVerification.article).toMatchObject({ state: "verified", path: "Clippings/Stamped.md" });
    expect(plugin.clipperSetup().setupNeeded()).toBe(false);
  });

  it("records nothing for an unstamped or mismatched note when nothing is waiting", async () => {
    vi.useFakeTimers();
    const app = new App();
    const plain = app.vault.seed("Clippings/Plain.md", "body", { frontmatter: { title: "x" } });
    const wrongVersion = app.vault.seed("Clippings/Old.md", "body", {
      frontmatter: { type: "article", schema_version: 99, source: "https://example.com", tags: ["source"] },
    });
    const plugin = passivePlugin(app);
    plugin.clipperSetup().queueVerification(plain);
    plugin.clipperSetup().queueVerification(wrongVersion);
    await vi.advanceTimersByTimeAsync(3000);
    expect(plugin.settings.clipperVerification.article).toBeUndefined();
    expect(plugin.activity.snapshot().records).toHaveLength(0);
  });
});
