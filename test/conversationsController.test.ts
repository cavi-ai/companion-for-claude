import { describe, it, expect, vi } from "vitest";
import { ConversationsController } from "../src/conversations/controller";
import { emptyState, saveConversation, newConversation, fromPersisted, type ConversationState } from "../src/conversations/store";
import type { ChatMessage } from "../src/types";
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

describe("answer regeneration persistence", () => {
  const original: ChatMessage[] = [
    { role: "user", content: "Summarize", contextSources: ["active note: Original.md"] },
    { role: "assistant", content: "The original answer" },
  ];
  const seed = () => saveConversation(emptyState(), { ...newConversation("c1", 1), messages: original }, 0);
  const input = { backend: "claude", model: "m", mode: "ask" as const, regenerating: true };

  it.each(["error", "stop", "reload"])("keeps the original exchange after %s", async (outcome) => {
    const { controller, state, persisted } = harness(seed());
    const turn = await controller.beginTurn("c1", [original[0]!], input);
    expect(persisted.at(-1)?.conversations[0]?.messages).toEqual(original);
    await controller.setTurnContext("c1", turn.turnId, ["active note: Different.md"]);
    expect(state().conversations[0]?.messages).toEqual(original);
    if (outcome === "error") await controller.interruptTurn("c1", turn.turnId, [{ role: "user", content: "Summarize" }, { role: "assistant", content: "Partial failed replacement" }], "Service unavailable");
    if (outcome === "stop") await controller.stopTurn("c1", turn.turnId);
    const reloaded = fromPersisted(JSON.parse(JSON.stringify(state())));
    expect(reloaded.conversations[0]?.messages).toEqual(original);
    expect(reloaded.conversations[0]?.activeTurn?.regenerating).toBe(true);
    expect(reloaded.conversations[0]?.activeTurn?.contextSources).toEqual(["active note: Different.md"]);
  });

  it("replaces the answer only on success and ignores an obsolete completion", async () => {
    const { controller, state } = harness(seed());
    const turn = await controller.beginTurn("c1", [original[0]!], input);
    const replacement: ChatMessage[] = [original[0]!, { role: "assistant", content: "A better answer" }];
    await controller.completeTurn("c1", "stale-turn", replacement);
    expect(state().conversations[0]?.messages).toEqual(original);
    await controller.completeTurn("c1", turn.turnId, replacement);
    expect(state().conversations[0]?.messages).toEqual(replacement);
    expect(state().conversations[0]?.activeTurn).toBeUndefined();
  });

  it.each([false, true])("keeps capped work continuable when replacement text exists: %s", async (hasText) => {
    const { controller, state } = harness(seed());
    const turn = await controller.beginTurn("c1", [original[0]!], input);
    const partial: ChatMessage[] = [original[0]!, { role: "assistant", content: "Partial work" }];
    await controller.capTurn("c1", turn.turnId, hasText ? partial : [original[0]!], "Continue with remaining steps");
    expect(state().conversations[0]?.messages).toEqual(hasText ? partial : original);
    expect(state().conversations[0]?.activeTurn?.state).toBe("capped");
    expect(state().conversations[0]?.activeTurn?.regenerating).toBeFalsy();
    expect(state().conversations[0]?.activeTurn?.handoff).toBe("Continue with remaining steps");
  });

  it("keeps the original when the provider completes without an answer", async () => {
    const { controller, state } = harness(seed());
    const turn = await controller.beginTurn("c1", [original[0]!], input);
    await controller.completeTurn("c1", turn.turnId, [original[0]!]);
    expect(state().conversations[0]?.messages).toEqual(original);
    expect(state().conversations[0]?.activeTurn?.state).toBe("interrupted");
  });
});

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

describe("ConversationsController.setTurnContext", () => {
  it("persists a snapshot on the matching user message without replacing the running receipt", async () => {
    const { controller, persisted, state } = harness();
    const turn = await controller.beginTurn(null, [{ role: "user", content: "Summarize" }], { backend: "anthropic", model: "m", mode: "ask" });
    const sources = ["active note: Original.md"];
    expect(await controller.setTurnContext(turn.conversationId, turn.turnId, sources)).toBe(true);
    sources[0] = "Different.md";
    const saved = JSON.parse(JSON.stringify(persisted.at(-1))) as ConversationState;
    expect(saved.conversations[0]?.messages[0]?.contextSources).toEqual(["active note: Original.md"]);
    expect(state().conversations[0]?.activeTurn?.state).toBe("running");
    const before = state();
    expect(await controller.setTurnContext(turn.conversationId, "stale-turn", ["Wrong.md"])).toBe(false);
    expect(state()).toBe(before);
  });

  it("rolls back a failed context save without changing the original request", async () => {
    let state = emptyState();
    let fail = false;
    const controller = new ConversationsController({
      state: { get: () => state, set: (next) => { state = next; } },
      persist: async () => { if (fail) throw new Error("Disk is full"); },
      activity: () => ({ start: () => undefined, update: () => undefined }) as unknown as ActivityStore,
      settings: () => ({ maxConversations: 0 }) as PluginSettings,
    });
    const turn = await controller.beginTurn(null, [{ role: "user", content: "Summarize" }], { backend: "anthropic", model: "m", mode: "ask" });
    const before = state;
    fail = true;
    await expect(controller.setTurnContext(turn.conversationId, turn.turnId, ["Original.md"])).rejects.toThrow("Disk is full");
    expect(state).toBe(before);
    expect(state.conversations[0]?.messages[0]?.contextSources).toBeUndefined();
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

describe("ConversationsController archive, rename, fork", () => {
  const seeded = () => saveConversation(emptyState(), { ...newConversation("c1", 1), title: "Plan", messages: [{ role: "user", content: "hi" }] }, 0);

  it("archives, unarchives, renames, and records the distilled note, persisting each", async () => {
    const { controller, persisted, state } = harness(seeded());
    await controller.archive("c1");
    expect(state().conversations[0]?.archivedAt).toBeTypeOf("number");
    await controller.unarchive("c1");
    expect(state().conversations[0]?.archivedAt).toBeUndefined();
    await controller.rename("c1", "  Renamed  ");
    expect(state().conversations[0]?.title).toBe("Renamed");
    await controller.rename("c1", "   ");
    expect(state().conversations[0]?.title).toBe("Renamed");
    await controller.setDistilledNote("c1", "Claude/Chats/x.md");
    expect(state().conversations[0]?.distilledNote).toBe("Claude/Chats/x.md");
    expect(persisted).toHaveLength(4);
  });

  it("fork stores a new conversation and leaves the source and active id alone", async () => {
    const { controller, state } = harness({ ...seeded(), activeId: "c1" });
    const fork = await controller.fork("c1");
    expect(fork.title).toBe("Fork of Plan");
    expect(fork.forkedFrom).toBe("c1");
    expect(state().conversations.map((c) => c.id)).toContain(fork.id);
    expect(state().activeId).toBe("c1");
  });

  it("createSeeded stores a one-message conversation", async () => {
    const { controller, state } = harness();
    const seed = { role: "user" as const, content: "body", display: "Continuing from: X" };
    const convo = await controller.createSeeded("Fork of X", seed);
    expect(state().conversations.find((c) => c.id === convo.id)?.messages).toEqual([seed]);
  });
});

describe("accepted attachment renames", () => {
  it("persists file and folder moves without changing conversation order or old snapshots", async () => {
    const original = [{ role: "user" as const, content: "Chart", media: [{ label: "A.png", kind: "image" as const, mime: "image/png", path: "Charts/A.png" }] }];
    const seed = saveConversation(emptyState(), { ...newConversation("c1", 1), messages: original }, 0);
    const { controller, state, persisted } = harness(seed);
    await controller.renameAttachments("Charts", "Figures");
    await controller.renameAttachments("Figures/A.png", "Figures/B.png");
    expect(original[0]!.media[0]!.path).toBe("Charts/A.png");
    expect(state().conversations[0]?.messages[0]?.media?.[0]).toMatchObject({ path: "Figures/B.png", label: "B.png" });
    expect(state().conversations[0]?.updatedAt).toBe(1);
    expect(persisted).toHaveLength(2);
    await controller.renameAttachments("Other", "Irrelevant");
    expect(persisted).toHaveLength(2);
  });
  it("does not restore a stale attachment path when a running answer finishes", async () => {
    const media = [{ label: "A.png", kind: "image" as const, mime: "image/png", path: "Charts/A.png" }];
    const messages = [{ role: "user" as const, content: "Chart", media }];
    const { controller, state } = harness();
    const turn = await controller.beginTurn(null, messages, { backend: "claude", model: "m", mode: "ask" });
    await controller.renameAttachments("Charts/A.png", "Charts/B.png");
    await controller.completeTurn(turn.conversationId, turn.turnId, [...messages, { role: "assistant", content: "Answer" }]);
    expect(state().conversations[0]?.messages[0]?.media?.[0]?.path).toBe("Charts/B.png");
  });
});


it("keeps renamed note references when a running answer saves an older message snapshot", async () => {
  const contextAttachments = { paths: [{ path: "Notes/A.md", kind: "note" as const }], pages: [] };
  const messages = [{ role: "user" as const, content: "Question A", contextAttachments }];
  const { controller, state } = harness();
  const turn = await controller.beginTurn(null, messages, { backend: "claude", model: "m", mode: "ask" });
  await controller.renameAttachments("Notes", "Archive");
  await controller.completeTurn(turn.conversationId, turn.turnId, [...messages, { role: "assistant", content: "Answer" }]);
  expect(state().conversations[0]?.messages[0]?.contextAttachments?.paths[0]?.path).toBe("Archive/A.md");
});
