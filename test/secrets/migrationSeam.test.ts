// The upgrade path every existing user hits: loadSettings() must move plaintext
// credentials out of data.json, keep them usable in memory, and say so once.
// This is the seam a future reorder would silently break.

import { beforeEach, describe, expect, it } from "vitest";
import { App, clearNotices, getNoticeMessages, setApiVersion } from "obsidian";
import ClaudeCompanionPlugin from "../../src/main";
import { secretIdFor } from "../../src/secrets/store";

interface Harness {
  plugin: ClaudeCompanionPlugin;
  onDisk: () => string;
}

function harness(initialSettings: Record<string, unknown>): Harness {
  let stored: unknown = { settings: initialSettings, conversations: [], activeConversationId: null };
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app: new App(),
    researchDeskPreferences: {},
    mcpSyncChain: Promise.resolve(),
    loadData: async () => structuredClone(stored),
    saveData: async (data: unknown) => { stored = structuredClone(data); },
  });
  return { plugin, onDisk: () => JSON.stringify(stored) };
}

describe("loadSettings migration seam", () => {
  beforeEach(() => {
    clearNotices();
    setApiVersion("1.11.5");
  });

  it("moves a plaintext key into secret storage and rewrites data.json without it", async () => {
    const { plugin, onDisk } = harness({ apiKey: "SENTINEL-KEY" });
    await plugin.loadSettings();

    expect(plugin.secrets().get(secretIdFor("apiKey"))).toBe("SENTINEL-KEY");
    expect(onDisk()).not.toContain("SENTINEL-KEY");
  });

  it("keeps the credential usable in memory after migrating", async () => {
    const { plugin } = harness({ apiKey: "SENTINEL-KEY" });
    await plugin.loadSettings();
    expect(plugin.settings.apiKey).toBe("SENTINEL-KEY");
  });

  it("tells the user to rotate, because moving a key does not un-leak it", async () => {
    const { plugin } = harness({ apiKey: "SENTINEL-KEY" });
    await plugin.loadSettings();
    const notices = getNoticeMessages().join(" ");
    expect(notices).toContain("Anthropic API key");
    expect(notices).toContain("rotate");
  });

  it("does not re-notify on the next load", async () => {
    const { plugin } = harness({ apiKey: "SENTINEL-KEY" });
    await plugin.loadSettings();
    clearNotices();
    await plugin.loadSettings();
    expect(getNoticeMessages()).toEqual([]);
    expect(plugin.settings.apiKey).toBe("SENTINEL-KEY");
  });

  it("stays silent when there was nothing to migrate", async () => {
    const { plugin } = harness({});
    await plugin.loadSettings();
    expect(getNoticeMessages()).toEqual([]);
  });

  it("below 1.11.5 leaves the key where it is rather than dropping it", async () => {
    setApiVersion("1.11.4");
    const { plugin, onDisk } = harness({ apiKey: "SENTINEL-KEY" });
    await plugin.loadSettings();

    expect(plugin.settings.apiKey).toBe("SENTINEL-KEY");
    expect(getNoticeMessages()).toEqual([]);
    // Nothing was persisted, so the original plaintext is still on disk.
    expect(onDisk()).toContain("SENTINEL-KEY");
  });

  /**
   * The migration persist() writes the whole payload, buildRuns included. If it
   * ran before restoreBuildRuns() had populated them, it would serialize the
   * empty initial value over the user's real runs — once, on the first load
   * after upgrade, silently. This pins the ordering.
   */
  it("does not wipe build runs when it migrates on first load", async () => {
    const run = {
      id: "run-1",
      title: "Ship the thing",
      specPath: "Claude/spec.md",
      trackerPath: "Claude/tracker.md",
      transport: "desktop",
      status: "completed",
      tasks: [{ title: "step one", status: "completed" }],
      activeTaskIndex: null,
      log: "",
      createdAt: 1,
      updatedAt: 2,
    };
    const { plugin, onDisk } = harness({ apiKey: "SENTINEL-KEY" });
    // Seed build runs alongside the plaintext credential, as a real upgrade would.
    Object.assign(plugin as unknown as Record<string, unknown>, {
      loadData: async () => structuredClone({
        settings: { apiKey: "SENTINEL-KEY" },
        conversations: [],
        activeConversationId: null,
        buildRuns: [run],
        activeBuildRunId: "run-1",
      }),
    });

    await plugin.loadSettings();

    expect(onDisk()).not.toContain("SENTINEL-KEY");
    const written = JSON.parse(onDisk()) as { buildRuns?: unknown[]; activeBuildRunId?: string | null };
    expect(written.buildRuns).toHaveLength(1);
    expect(written.activeBuildRunId).toBe("run-1");
  });

  it("migrates every populated credential, not just the API key", async () => {
    const { plugin, onDisk } = harness({ apiKey: "K1", mcpToken: "K2", cloudReplyToken: "K3" });
    await plugin.loadSettings();

    expect(plugin.secrets().get(secretIdFor("apiKey"))).toBe("K1");
    expect(plugin.secrets().get(secretIdFor("mcpToken"))).toBe("K2");
    expect(plugin.secrets().get(secretIdFor("cloudReplyToken"))).toBe("K3");
    for (const sentinel of ["K1", "K2", "K3"]) expect(onDisk()).not.toContain(`"${sentinel}"`);
  });
});
