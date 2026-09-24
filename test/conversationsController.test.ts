import { describe, it, expect } from "vitest";
import { ConversationsController } from "../src/conversations/controller";
import { emptyState, saveConversation, newConversation, type ConversationState } from "../src/conversations/store";
import type { ActivityStore } from "../src/activity/store";
import type { PluginSettings } from "../src/types";

function harness(seed: ConversationState = emptyState()) {
  let state = seed;
  const persisted: ConversationState[] = [];
  const controller = new ConversationsController({
    state: { get: () => state, set: (next) => { state = next; } },
    persist: async () => { persisted.push(state); },
    activity: () => ({} as ActivityStore),
    settings: () => ({ maxConversations: 0 } as PluginSettings),
  });
  return { controller, persisted, state: () => state };
}

describe("ConversationsController.setProject", () => {
  it("sets projectId on the named conversation and persists", async () => {
    const seed = saveConversation(emptyState(), newConversation("c1", 1), 0);
    const { controller, persisted, state } = harness(seed);
    await controller.setProject("c1", "Claude/Projects/Launch.md");
    expect(state().conversations[0]?.projectId).toBe("Claude/Projects/Launch.md");
    expect(persisted).toHaveLength(1);
  });

  it("clears projectId with null", async () => {
    let seed = saveConversation(emptyState(), newConversation("c1", 1), 0);
    seed = { ...seed, conversations: seed.conversations.map((c) => ({ ...c, projectId: "old.md" })) };
    const { controller, state } = harness(seed);
    await controller.setProject("c1", null);
    expect(state().conversations[0]?.projectId).toBeUndefined();
  });

  it("is a no-op for an unknown conversation id", async () => {
    const { controller, persisted } = harness();
    await controller.setProject("ghost", "p.md");
    expect(persisted).toHaveLength(0);
  });
});
