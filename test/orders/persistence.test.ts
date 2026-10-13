import { describe, expect, it } from "vitest";
import { buildPlugin } from "../fakes/plugin";

const state = { "o.md": { enabledAt: 1, lastRunAt: 2, fired: ["a.md"], hourStart: 3, hourCount: 4 } };
const queue = [{ id: "r#0", orderId: "o.md", orderName: "o", runPath: "r", path: "a.md", edits: [{ old_str: "a", new_str: "b" }], createdAt: 5 }];

describe("standing order persistence", () => {
  it("writes order state and the edit queue to data.json and restores them", async () => {
    let saved: unknown = null;
    const plugin = buildPlugin({
      convState: { conversations: [], activeId: null },
      saveData: async (data: unknown) => { saved = structuredClone(data); },
      loadData: async () => saved,
    });
    const seam = plugin as unknown as { persist(): Promise<void>; loadSettings(): Promise<void> };
    plugin.orders().restore(state, queue);

    await seam.persist();
    expect(saved).toMatchObject({ standingOrders: state, orderEditQueue: queue });

    plugin.orders().restore({}, []);
    await seam.loadSettings();
    expect(plugin.orders().state()).toEqual(state);
    expect(plugin.orders().listQueuedEdits()).toEqual(queue);
  });
});
