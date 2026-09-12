import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../src/activity/store";
import ClaudeCompanionPlugin from "../src/main";
import { DEFAULT_SETTINGS, type ChatMessage } from "../src/types";

const user = (content: string): ChatMessage => ({ role: "user", content });

function harness(): { plugin: ClaudeCompanionPlugin; saves: unknown[] } {
  const saves: unknown[] = [];
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS),
    convState: { conversations: [], activeId: null },
    researchDeskPreferences: {},
    buildRuns: {},
    activeBuildRunId: null,
    _activity: new ActivityStore({ successRetentionMs: 60_000 }),
    saveData: async (data: unknown) => { saves.push(structuredClone(data)); },
  });
  return { plugin, saves };
}

describe("plugin durable Chat turn lifecycle", () => {
  it("persists the submitted message before returning a running turn", async () => {
    const { plugin, saves } = harness();

    const active = await plugin.beginActiveConversationTurn([user("Research this")], {
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

  it("stops the exact runtime once and durably marks it interrupted", async () => {
    const { plugin } = harness();
    const active = await plugin.beginActiveConversationTurn([user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const stop = vi.fn();
    plugin.registerActiveChatTurn(active.conversationId, active.turnId, stop);

    await plugin.stopActiveChatTurn(active.conversationId, active.turnId);
    await plugin.stopActiveChatTurn(active.conversationId, active.turnId);

    expect(stop).toHaveBeenCalledOnce();
    expect(plugin.getActiveConversation()?.activeTurn).toMatchObject({ state: "interrupted" });
    expect(plugin.activity.snapshot().records[0]).toMatchObject({
      state: "paused",
      recovery: expect.arrayContaining([expect.objectContaining({ id: "resume-chat-turn" })]),
    });
  });

  it("persists assistant output before clearing the matching receipt", async () => {
    const { plugin, saves } = harness();
    const messages = [user("Research this")];
    const active = await plugin.beginActiveConversationTurn(messages, {
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
    const active = await plugin.beginActiveConversationTurn([user("Research this")], {
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

    await expect(plugin.beginActiveConversationTurn([user("Do not lose this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    })).rejects.toThrow("disk full");

    expect(plugin.getActiveConversation()).toBeNull();
    expect(plugin.activity.snapshot().records).toEqual([]);
  });

  it("still terminates the live process when persisting Stop fails", async () => {
    const { plugin } = harness();
    const active = await plugin.beginActiveConversationTurn([user("Research this")], {
      backend: "claude-cli", model: "claude-sonnet-5", mode: "act",
    });
    const stop = vi.fn();
    plugin.registerActiveChatTurn(active.conversationId, active.turnId, stop);
    vi.spyOn(plugin, "saveData").mockRejectedValueOnce(new Error("disk full"));

    await expect(plugin.stopActiveChatTurn(active.conversationId, active.turnId)).rejects.toThrow("disk full");

    expect(stop).toHaveBeenCalledOnce();
    expect(plugin.getActiveConversation()?.activeTurn?.state).toBe("interrupted");
  });
});
