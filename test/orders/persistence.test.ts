import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import ClaudeCompanionPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";

const state = { "o.md": { enabledAt: 1, lastRunAt: 2, fired: ["a.md"], hourStart: 3, hourCount: 4 } };
const queue = [{ id: "r#0", orderId: "o.md", orderName: "o", runPath: "r", path: "a.md", edits: [{ old_str: "a", new_str: "b" }], createdAt: 5 }];

describe("standing order persistence", () => {
  it("writes order state and the edit queue to data.json and restores them", async () => {
    let saved: unknown = null;
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app: new App(),
      settings: structuredClone(DEFAULT_SETTINGS),
      convState: { conversations: [], activeId: null },
      ordersState: state,
      orderEditQueue: queue,
      saveData: async (data: unknown) => { saved = structuredClone(data); },
      loadData: async () => saved,
    });
    const seam = plugin as unknown as { persist(): Promise<void>; loadSettings(): Promise<void>; ordersState: unknown; orderEditQueue: unknown };

    await seam.persist();
    expect(saved).toMatchObject({ standingOrders: state, orderEditQueue: queue });

    seam.ordersState = {};
    seam.orderEditQueue = [];
    await seam.loadSettings();
    expect(seam.ordersState).toEqual(state);
    expect(seam.orderEditQueue).toEqual(queue);
  });
});
