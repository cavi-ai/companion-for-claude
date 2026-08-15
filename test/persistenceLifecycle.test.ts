import { afterEach, describe, expect, it } from "vitest";
import { App, setApiVersion } from "obsidian";
import ClaudeCompanionPlugin from "../src/main";
import { SECRET_FIELDS } from "../src/secrets/store";
import { DEFAULT_SETTINGS } from "../src/types";

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

describe("plugin persistence lifecycle", () => {
  it("cannot let an older settings and conversation snapshot overwrite a newer one", async () => {
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    let persisted: unknown = null;
    let saveNumber = 0;
    Object.assign(plugin as unknown as Record<string, unknown>, {
      settings: { ...structuredClone(DEFAULT_SETTINGS), model: "older-model" },
      convState: { conversations: [{ id: "old" }], activeId: "old" },
      researchDeskPreferences: {},
      saveData: async (data: unknown) => {
        const snapshot = structuredClone(data);
        const number = saveNumber++;
        await delay(number === 0 ? 20 : 0);
        persisted = snapshot;
      },
    });
    const seam = plugin as unknown as { persist(): Promise<void>; settings: typeof DEFAULT_SETTINGS; convState: unknown };

    const older = seam.persist();
    seam.settings = { ...structuredClone(DEFAULT_SETTINGS), model: "newer-model" };
    seam.convState = { conversations: [{ id: "new" }], activeId: "new" };
    const newer = seam.persist();
    await Promise.all([older, newer]);

    expect(persisted).toMatchObject({
      settings: { model: "newer-model" },
      conversations: [{ id: "new" }],
      activeConversationId: "new",
    });
  });
});

/**
 * The guarantee, asserted against the exact bytes handed to saveData: no
 * credential reaches data.json. Sentinel-on-whole-payload rather than per-field
 * checks, so a future stray write cannot quietly reintroduce plaintext.
 */
describe("credentials never reach data.json", () => {
  afterEach(() => setApiVersion("1.11.5"));

  const seedPlugin = (): { plugin: ClaudeCompanionPlugin; saved: () => string } => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    for (const field of SECRET_FIELDS) settings[field] = `SENTINEL-${field}`;
    let raw = "";
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app: new App(),
      settings,
      convState: { conversations: [], activeId: null },
      researchDeskPreferences: {},
      mcpSyncChain: Promise.resolve(),
      saveData: async (data: unknown) => { raw = JSON.stringify(data); },
    });
    return { plugin, saved: () => raw };
  };

  it("strips every credential from the persisted payload", async () => {
    const { plugin, saved } = seedPlugin();
    await (plugin as unknown as { persist(): Promise<void> }).persist();
    for (const field of SECRET_FIELDS) {
      expect(saved()).not.toContain(`SENTINEL-${field}`);
    }
    expect(saved()).not.toContain("SENTINEL");
  });

  it("keeps the credentials in memory so providers still work", async () => {
    const { plugin } = seedPlugin();
    await (plugin as unknown as { persist(): Promise<void> }).persist();
    expect(plugin.settings.apiKey).toBe("SENTINEL-apiKey");
  });

  it("writes credentials through to the secret store on save", async () => {
    const { plugin, saved } = seedPlugin();
    await plugin.saveSettings();
    expect(saved()).not.toContain("SENTINEL");
    expect(plugin.secrets().get("claude-companion-api-key")).toBe("SENTINEL-apiKey");
  });

  it("below 1.11.5 keeps today's behaviour rather than dropping the key", async () => {
    setApiVersion("1.11.4");
    const { plugin, saved } = seedPlugin();
    await (plugin as unknown as { persist(): Promise<void> }).persist();
    expect(saved()).toContain("SENTINEL-apiKey");
  });
});
