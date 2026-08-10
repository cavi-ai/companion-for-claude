import { describe, expect, it } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
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
