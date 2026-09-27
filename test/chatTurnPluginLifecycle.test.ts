import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../src/activity/store";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS, type ChatMessage } from "../src/types";
import { fromPersisted } from "../src/conversations/store";

const user = (content: string): ChatMessage => ({ role: "user", content });

function harness(): { plugin: ClaudeCompanionPlugin; saves: unknown[] } {
  const saves: unknown[] = [];
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS),
    convState: { conversations: [], activeId: null },
    researchDeskPreferences: {},
    _activity: new ActivityStore({ successRetentionMs: 60_000 }),
    saveData: async (data: unknown) => { saves.push(structuredClone(data)); },
  });
  return { plugin, saves };
}

describe("plugin durable Chat turn lifecycle", () => {
  it("saves the last proposed edit for review after a restart and clears it after application", async () => {
    const { plugin, saves } = harness();
    const active = await plugin.beginActiveConversationTurn(null, [user("Revise A.md")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const proposal = { path: "A.md", edits: [{ old_str: "old", new_str: "new" }], description: "Clarity" };
    await plugin.saveChatEditProposal(active.conversationId, proposal);
    expect(plugin.getActiveConversation()?.lastEditProposal).toMatchObject(proposal);
    const saved = saves.at(-1) as { conversations: unknown[]; activeConversationId: string };
    expect(fromPersisted({ conversations: saved.conversations, activeId: saved.activeConversationId }).conversations[0]?.lastEditProposal).toMatchObject(proposal);

    await plugin.clearChatEditProposal(active.conversationId);
    expect(plugin.getActiveConversation()?.lastEditProposal).toBeUndefined();
  });
  it("persists the submitted message before returning a running turn", async () => {
    const { plugin, saves } = harness();

    const active = await plugin.beginActiveConversationTurn(null, [user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });

    expect(active.conversationId).toMatch(/^c/);
    expect(saves.at(-1)).toMatchObject({
      activeConversationId: active.conversationId,
      conversations: [{ messages: [user("Research this")], activeTurn: { id: active.turnId, state: "running" } }],
    });
    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      id: `chat-turn:${active.conversationId}`,
      kind: "chat-turn",
      state: "running",
      recovery: expect.arrayContaining([
        expect.objectContaining({ id: "open-chat" }),
        expect.objectContaining({ id: "stop-chat-turn" }),
      ]),
    });
  });

  it("beginTurn(null, …) creates a conversation and makes it active — the leaf that starts a turn is the focused leaf", async () => {
    const { plugin } = harness();
    const first = await plugin.beginActiveConversationTurn(null, [user("First tab")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    expect(plugin.getActiveConversation()?.id).toBe(first.conversationId);

    const second = await plugin.beginActiveConversationTurn(null, [user("Second tab")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });

    expect(second.conversationId).not.toBe(first.conversationId);
    // Starting a turn makes ITS conversation active — the caller is the focused leaf.
    expect(plugin.getActiveConversation()?.id).toBe(second.conversationId);
  });

  it("beginTurn(id, …) on an existing background conversation makes it active", async () => {
    const { plugin } = harness();
    const a = await plugin.beginActiveConversationTurn(null, [user("Tab a")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const b = await plugin.beginActiveConversationTurn(null, [user("Tab b")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    expect(plugin.getActiveConversation()?.id).toBe(b.conversationId);

    await plugin.beginActiveConversationTurn(a.conversationId, [user("Tab a"), user("Again")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });

    expect(plugin.getActiveConversation()?.id).toBe(a.conversationId);
  });

  it("completeTurn/interruptTurn on a conversation that is not active leaves activeId unchanged", async () => {
    const { plugin } = harness();
    const a = await plugin.beginActiveConversationTurn(null, [user("Tab a")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const b = await plugin.beginActiveConversationTurn(null, [user("Tab b")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    expect(plugin.getActiveConversation()?.id).toBe(b.conversationId);

    await plugin.completeActiveConversationTurn(a.conversationId, a.turnId, [user("Tab a"), { role: "assistant", content: "Done" }]);
    expect(plugin.getActiveConversation()?.id).toBe(b.conversationId);

    const c = await plugin.beginActiveConversationTurn(null, [user("Tab c")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    expect(plugin.getActiveConversation()?.id).toBe(c.conversationId);

    await plugin.interruptActiveConversationTurn(b.conversationId, b.turnId, [user("Tab b")], "boom");
    expect(plugin.getActiveConversation()?.id).toBe(c.conversationId);
  });

  it("beginTurn(id, …) on an existing id keeps that id and appends to it", async () => {
    const { plugin } = harness();
    const first = await plugin.beginActiveConversationTurn(null, [user("Hello")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    await plugin.completeActiveConversationTurn(first.conversationId, first.turnId, [user("Hello"), { role: "assistant", content: "Hi" }]);

    const second = await plugin.beginActiveConversationTurn(first.conversationId, [user("Hello"), { role: "assistant", content: "Hi" }, user("Again")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });

    expect(second.conversationId).toBe(first.conversationId);
    expect(plugin.listConversations()).toHaveLength(1);
    expect(plugin.listConversations()[0]?.messages).toHaveLength(3);
  });

  it("stops the exact runtime once and durably marks it interrupted", async () => {
    const { plugin } = harness();
    const active = await plugin.beginActiveConversationTurn(null, [user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const stop = vi.fn();
    plugin.registerActiveChatTurn(active.conversationId, active.turnId, stop);

    await plugin.stopActiveChatTurn(active.conversationId, active.turnId);
    await plugin.stopActiveChatTurn(active.conversationId, active.turnId);

    expect(stop).toHaveBeenCalledOnce();
    expect(plugin.getActiveConversation()?.activeTurn).toMatchObject({ state: "interrupted" });
    expect(plugin.getActiveConversation()?.messages[0]).toMatchObject({ content: "Research this", contextExcluded: true });
    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      state: "paused",
      recovery: expect.arrayContaining([expect.objectContaining({ id: "resume-chat-turn" })]),
    });
  });

  it("persists assistant output before clearing the matching receipt", async () => {
    const { plugin, saves } = harness();
    const messages = [user("Research this")];
    const active = await plugin.beginActiveConversationTurn(null, messages, {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });

    await plugin.completeActiveConversationTurn(active.conversationId, active.turnId, [...messages, { role: "assistant", content: "Done" }]);

    expect(plugin.getActiveConversation()).toMatchObject({ messages: [...messages, { role: "assistant", content: "Done" }] });
    expect(plugin.getActiveConversation()?.activeTurn).toBeUndefined();
    expect(saves.at(-1)).toMatchObject({ conversations: [{ messages: [...messages, { role: "assistant", content: "Done" }] }] });
    expect(plugin.activity.snapshot().records).toEqual([]);
  });

  it("routes global Activity stop and resume actions to the exact conversation", async () => {
    const { plugin } = harness();
    const active = await plugin.beginActiveConversationTurn(null, [user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const stop = vi.fn();
    plugin.registerActiveChatTurn(active.conversationId, active.turnId, stop);

    await plugin.runActivityRecovery(`chat-turn:${active.conversationId}`, "stop-chat-turn");

    const view = { loadConversation: vi.fn(), resumeInterruptedTurn: vi.fn(async () => undefined) };
    vi.spyOn(plugin, "activateView").mockResolvedValue(view as never);
    await plugin.runActivityRecovery(`chat-turn:${active.conversationId}`, "resume-chat-turn");

    expect(stop).toHaveBeenCalledOnce();
    expect(view.loadConversation).toHaveBeenCalledWith(expect.objectContaining({ id: active.conversationId }));
    expect(view.resumeInterruptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      id: active.conversationId,
      activeTurn: expect.objectContaining({ state: "interrupted" }),
    }));
  });

  it("rolls back a turn that could not be durably saved before execution", async () => {
    const { plugin } = harness();
    vi.spyOn(plugin, "saveData").mockRejectedValueOnce(new Error("disk full"));

    await expect(plugin.beginActiveConversationTurn(null, [user("Do not lose this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    })).rejects.toThrow("disk full");

    expect(plugin.getActiveConversation()).toBeNull();
    expect(plugin.activity.snapshot().records).toEqual([]);
  });

  it("still terminates the live process when persisting Stop fails", async () => {
    const { plugin } = harness();
    const active = await plugin.beginActiveConversationTurn(null, [user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const stop = vi.fn();
    plugin.registerActiveChatTurn(active.conversationId, active.turnId, stop);
    vi.spyOn(plugin, "saveData").mockRejectedValueOnce(new Error("disk full"));

    await expect(plugin.stopActiveChatTurn(active.conversationId, active.turnId)).rejects.toThrow("disk full");

    expect(stop).toHaveBeenCalledOnce();
    expect(plugin.getActiveConversation()?.activeTurn?.state).toBe("interrupted");
  });

  it("stops the runtime before a slow persistence write settles", async () => {
    const { plugin } = harness();
    const active = await plugin.beginActiveConversationTurn(null, [user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const stop = vi.fn();
    plugin.registerActiveChatTurn(active.conversationId, active.turnId, stop);
    let releaseSave!: () => void;
    vi.spyOn(plugin, "saveData").mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSave = resolve; }));

    const stopping = plugin.stopActiveChatTurn(active.conversationId, active.turnId);
    expect(stop).toHaveBeenCalledOnce();
    expect(plugin.getActiveConversation()?.activeTurn?.state).toBe("interrupted");
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf("function"));
    releaseSave();
    await stopping;
  });
});
