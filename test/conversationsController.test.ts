import { describe, it, expect, vi } from "vitest";
import { ConversationsController } from "../src/conversations/controller";
import { emptyState, saveConversation, newConversation, type ConversationState } from "../src/conversations/store";
import type { ActivityStore } from "../src/activity/store";
import type { PluginSettings } from "../src/types";

function harness(seed: ConversationState = emptyState()) {
  let state = seed;
  const persisted: ConversationState[] = [];
  const activity = { start: vi.fn(), update: vi.fn(), dismiss: vi.fn() };
  const controller = new ConversationsController({
    state: { get: () => state, set: (next) => { state = next; } },
    persist: async () => { persisted.push(state); },
    activity: () => activity as unknown as ActivityStore,
    settings: () => ({ maxConversations: 0 } as PluginSettings),
  });
  return { controller, persisted, state: () => state, activity };
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

describe("ConversationsController.capTurn", () => {
  const messages = [{ role: "user" as const, content: "Research everything" }];

  it("settles the receipt as capped with its handoff and keeps messages in context", async () => {
    const { controller, state } = harness();
    const { conversationId, turnId } = await controller.beginTurn(null, messages, { backend: "anthropic", model: "m", mode: "act" });
    const withReply = [...messages, { role: "assistant" as const, content: "partial answer" }];

    await controller.capTurn(conversationId, turnId, withReply, "Tools used: vault_search");

    const conversation = state().conversations.find((c) => c.id === conversationId);
    expect(conversation?.activeTurn).toMatchObject({ id: turnId, state: "capped", handoff: "Tools used: vault_search" });
    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages.every((m) => !m.contextExcluded)).toBe(true);
  });

  it("carries continuationDepth from beginTurn through to the capped receipt", async () => {
    const { controller, state } = harness();
    const { conversationId, turnId } = await controller.beginTurn(null, messages, { backend: "anthropic", model: "m", mode: "act", continuationDepth: 2 });

    await controller.capTurn(conversationId, turnId, messages, "handoff");

    expect(state().conversations[0]?.activeTurn).toMatchObject({ state: "capped", continuationDepth: 2 });
  });

  it("is a no-op when the receipt is not running", async () => {
    const { controller, persisted, state } = harness();
    const { conversationId, turnId } = await controller.beginTurn(null, messages, { backend: "anthropic", model: "m", mode: "act" });
    await controller.capTurn(conversationId, turnId, messages, "handoff");
    const before = state();
    const persistedBefore = persisted.length;

    await controller.capTurn(conversationId, turnId, messages, "other");

    expect(state()).toBe(before);
    expect(persisted).toHaveLength(persistedBefore);
  });

  it("marks the activity paused with a Continue recovery", async () => {
    const { controller, activity } = harness();
    const { conversationId, turnId } = await controller.beginTurn(null, messages, { backend: "anthropic", model: "m", mode: "act" });

    await controller.capTurn(conversationId, turnId, messages, "handoff");

    expect(activity.update).toHaveBeenLastCalledWith(`chat-turn:${conversationId}`, expect.objectContaining({
      state: "paused",
      recovery: expect.arrayContaining([expect.objectContaining({ id: "resume-chat-turn", label: "Continue" })]),
    }));
  });
});
