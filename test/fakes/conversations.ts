import { vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { ConversationsController } from "../../src/conversations/controller";
import { SessionActions } from "../../src/conversations/sessionActions";
import { emptyState, type ConversationState } from "../../src/conversations/store";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";

/** A real conversations controller and session actions over in-memory state, shaped as the plugin members the chat views call. */
export function conversationFakes(seed: Partial<ConversationState> = {}, settings: PluginSettings = structuredClone(DEFAULT_SETTINGS)) {
  const state = { current: { ...emptyState(), ...seed } };
  const activity = new ActivityStore({ successRetentionMs: 60_000 });
  const conversations = new ConversationsController({
    state: { get: () => state.current, set: (next) => { state.current = next; } },
    persist: async () => undefined,
    activity: () => activity,
    settings: () => settings,
  });
  const distill = vi.fn(async (_id: string): Promise<string | null> => "Claude/Chats/x.md");
  const sessionActions = new SessionActions({
    find: (id) => conversations.list().find((c) => c.id === id),
    archive: (id) => conversations.archive(id),
    fork: (id) => conversations.fork(id),
    createSeeded: (title, seed, projectId) => conversations.createSeeded(title, seed, projectId),
    distill,
    readNote: async () => null,
    openInNewTab: async () => undefined,
  });
  /** Replaces the turn lifecycle with spies that resolve a fixed turn, for tests that do not exercise persistence. */
  const stubTurns = () => ({
    begin: vi.spyOn(conversations, "beginTurn").mockResolvedValue({ conversationId: "conversation-1", turnId: "turn-1" }),
    context: vi.spyOn(conversations, "setTurnContext").mockResolvedValue(true),
    register: vi.spyOn(conversations, "registerTurn").mockReturnValue(() => undefined),
    complete: vi.spyOn(conversations, "completeTurn").mockResolvedValue(undefined),
    interrupt: vi.spyOn(conversations, "interruptTurn").mockResolvedValue(undefined),
  });
  return { conversations, sessionActions, settings, state, distill, stubTurns, host: { conversations: () => conversations, sessionActions: () => sessionActions } };
}
