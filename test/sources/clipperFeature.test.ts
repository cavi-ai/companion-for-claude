import { clipperTemplateFor } from "../../src/sources/clipperTemplate";
import { getSchema } from "../../src/sources/registry";
import { App, type FakeElement } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { ClipperFeature } from "../../src/sources/clipperFeature";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { ClipperSetupModal } from "../../src/view/ClipperSetupModal";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(over: Partial<PluginSettings> = {}) {
  const app = new App();
  const settings: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), sourceBaseTags: ["source"], ...over };
  const persist = vi.fn(async () => undefined);
  const saveSettings = vi.fn(async () => undefined);
  const activity = new ActivityStore({ successRetentionMs: 60_000 });
  const exported: Array<{ fileName: string; mimeType: string; json: string }> = [];
  const exportJson = vi.fn(async (artifact) => { exported.push(artifact); return true; });
  const feature = new ClipperFeature({ app, settings: () => settings, persist, saveSettings, activity: () => activity, exportJson });
  return { app, settings, persist, saveSettings, activity, feature, exported, exportJson };
}

const stamped = { type: "article", schema_version: 1, clipper_template: clipperTemplateFor(getSchema("article"), { path: "Clippings", tags: ["source"] }).properties.find(({ name }) => name === "clipper_template")!.value, source: "https://example.com", tags: ["source"] };

describe("ClipperFeature.exportTemplates", () => {
  it("writes one template per source type, stores the fingerprint and saves settings", async () => {
    const { app, settings, saveSettings, feature } = setup();
    expect(settings.clipperTemplateFingerprint).toBe("");

    await expect(feature.exportTemplates()).resolves.toEqual({ folder: "Claude/Clipper templates", count: 3 });

    const written = app.vault.getFiles().filter((f) => f.path.startsWith("Claude/Clipper templates/"));
    expect(written).toHaveLength(3);
    expect(settings.clipperTemplateFingerprint).not.toBe("");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("replaces existing template files on a second export", async () => {
    const { app, feature } = setup();
    await feature.exportTemplates();
    await feature.exportTemplates();
    expect(app.vault.getFiles().filter((f) => f.path.startsWith("Claude/Clipper templates/"))).toHaveLength(3);
  });

  it("keeps the fingerprint unchanged if the host changes a JSON file to Markdown", async () => {
    const { app, settings, feature } = setup();
    const create = app.vault.create.bind(app.vault);
    vi.spyOn(app.vault, "create").mockImplementation((path, content) => create(`${path}.md`, content));
    await expect(feature.exportTemplates()).rejects.toThrow(/intact .json file/);
    expect(settings.clipperTemplateFingerprint).toBe("");
  });

  it("does not mark a partial export current when one file cannot be written", async () => {
    const { app, settings, feature } = setup();
    const create = app.vault.create.bind(app.vault);
    vi.spyOn(app.vault, "create").mockImplementation((path, content) => path.includes("video") ? Promise.reject(new Error("Write failed")) : create(path, content));
    await expect(feature.exportTemplates()).rejects.toThrow("Write failed");
    expect(settings.clipperTemplateFingerprint).toBe("");
    expect(feature.setupNeeded()).toBe(true);
  });
});

describe("ClipperFeature status", () => {
  it("is not set up until templates are exported, current after, and update-available once schemas move", async () => {
    const { settings, feature } = setup();
    expect(feature.status()).toBe("not-set-up");
    expect(feature.setupNeeded()).toBe(true);

    await feature.exportTemplates();
    expect(feature.status()).toBe("current");
    expect(feature.setupNeeded()).toBe(true);

    settings.sourceBaseTags = ["source", "changed"];
    expect(feature.status()).toBe("update-available");
  });

  it("needs no setup once a template is verified", () => {
    const { settings, feature } = setup();
    const fingerprintOf = (): string => (feature as unknown as { setups(): Array<{ fingerprint: string }> }).setups()[0]!.fingerprint;
    settings.clipperVerification.article = { fingerprint: fingerprintOf(), state: "verified", startedAt: 1, verifiedAt: 2, mismatches: [] };
    expect(feature.setupNeeded()).toBe(false);
    expect(feature.status()).toBe("current");
  });
});

describe("ClipperFeature.templatesStale", () => {
  it("is false before any export, false right after one, true after the inbox moves", async () => {
    const { settings, feature } = setup();
    expect(feature.templatesStale()).toBe(false);
    await feature.exportTemplates();
    expect(feature.templatesStale()).toBe(false);
    settings.sourceInboxFolder = "Elsewhere";
    expect(feature.templatesStale()).toBe(true);
  });
});

describe("ClipperFeature.openSetup", () => {
  function openModal(feature: ClipperFeature): FakeElement {
    let root!: FakeElement;
    const open = ClipperSetupModal.prototype.open;
    vi.spyOn(ClipperSetupModal.prototype, "open").mockImplementation(function (this: ClipperSetupModal) {
      open.call(this);
      root = this.contentEl as unknown as FakeElement;
    });
    feature.openSetup();
    return root;
  }
  const press = async (root: FakeElement, label: string): Promise<void> => {
    root.querySelectorAll("button").find(({ textContent }) => textContent === label)?.dispatchEvent({ type: "click" });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

  it("marks the template as waiting and starts an activity when the JSON is copied", async () => {
    const { settings, persist, activity, feature } = setup();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.spyOn(Date, "now").mockReturnValue(1234);

    await press(openModal(feature), "Copy template JSON");

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion"'));
    expect(settings.clipperVerification.article).toMatchObject({ state: "waiting", startedAt: 1234, mismatches: [] });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(activity.snapshot().records).toEqual([expect.objectContaining({ id: "clipper-verification:article", title: "Waiting for a article test clip" })]);
    vi.unstubAllGlobals();
  });

  it("exports the same JSON artifact to the device and waits for a test clip", async () => {
    const { feature, exported, settings } = setup();
    await press(openModal(feature), "Save JSON file");
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ fileName: "companion-article-clipper.json", mimeType: "application/json" });
    expect(JSON.parse(exported[0]!.json)).toMatchObject({ name: "Companion: article" });
    expect(settings.clipperVerification.article?.state).toBe("waiting");
  });

  it("does not wait for a test clip when file export is cancelled", async () => {
    const { feature, exportJson, settings } = setup();
    exportJson.mockResolvedValueOnce(false);
    await press(openModal(feature), "Save JSON file");
    expect(settings.clipperVerification.article).toBeUndefined();
  });
});

describe("ClipperFeature.queueVerification", () => {
  it("does not verify a note whose source metadata was added by enrichment alone", async () => {
    vi.useFakeTimers();
    const { app, settings, feature } = setup();
    const { clipper_template: _stamp, ...enriched } = stamped;
    feature.queueVerification(app.vault.seed("Clippings/enriched.md", "body", { frontmatter: { ...enriched, source_enriched: true } }));
    await vi.advanceTimersByTimeAsync(600);
    expect(settings.clipperVerification.article).toBeUndefined();
  });
  it("ignores notes outside the inbox when nothing is waiting", async () => {
    vi.useFakeTimers();
    const { app, feature } = setup();
    feature.queueVerification(app.vault.seed("Notes/a.md", "x", { frontmatter: stamped }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("verifies a stamped inbox clip with nothing waiting and persists it", async () => {
    vi.useFakeTimers();
    const { app, settings, persist, feature } = setup();
    feature.queueVerification(app.vault.seed("Clippings/a.md", "x", { frontmatter: stamped }));
    await vi.advanceTimersByTimeAsync(600);
    expect(settings.clipperVerification.article).toMatchObject({ state: "verified", path: "Clippings/a.md", mismatches: [] });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("restarts the timer when the same file is queued again", () => {
    vi.useFakeTimers();
    const { app, feature } = setup();
    const file = app.vault.seed("Clippings/a.md", "x", { frontmatter: stamped });
    feature.queueVerification(file);
    feature.queueVerification(file);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retries while metadata is missing, then reports a waiting template's frontmatter-less clip", async () => {
    vi.useFakeTimers();
    const { app, settings, activity, feature } = setup();
    settings.clipperVerification.article = { fingerprint: "fp", state: "waiting", startedAt: 5, mismatches: [] };
    feature.queueVerification(app.vault.seed("Clippings/raw.md", "plain"));
    await vi.advanceTimersByTimeAsync(600);
    expect(settings.clipperVerification.article?.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(2400);
    expect(settings.clipperVerification.article).toMatchObject({ state: "needs-attention", path: "Clippings/raw.md" });
    expect(activity.snapshot().records[0]).toMatchObject({ id: "clipper-verification:article", state: "needs-attention" });
  });

  it("verifies a waiting template from the matching clip and finishes the activity", async () => {
    vi.useFakeTimers();
    const { app, settings, activity, feature } = setup();
    settings.clipperVerification.article = { fingerprint: "fp", state: "waiting", startedAt: 5, mismatches: [] };
    feature.queueVerification(app.vault.seed("Clippings/ok.md", "x", { frontmatter: stamped }));
    await vi.advanceTimersByTimeAsync(600);
    expect(settings.clipperVerification.article).toMatchObject({ state: "verified", path: "Clippings/ok.md" });
    expect(activity.snapshot().records[0]).toMatchObject({ state: "succeeded" });
  });

  it("ignores a non-clip note in the inbox while waiting", async () => {
    vi.useFakeTimers();
    const { app, settings, feature } = setup();
    settings.clipperVerification.article = { fingerprint: "fp", state: "waiting", startedAt: 5, mismatches: [] };
    feature.queueVerification(app.vault.seed("Clippings/plain.md", "x", { frontmatter: { title: "x" } }));
    await vi.advanceTimersByTimeAsync(600);
    expect(settings.clipperVerification.article?.state).toBe("waiting");
  });

  it("dispose cancels pending verifications", () => {
    vi.useFakeTimers();
    const { app, feature } = setup();
    feature.queueVerification(app.vault.seed("Clippings/a.md", "x", { frontmatter: stamped }));
    expect(vi.getTimerCount()).toBe(1);
    feature.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
