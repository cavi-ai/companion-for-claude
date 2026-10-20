import type { ActivityStore } from "../activity/store";
import { ChatTurnLifecycle } from "../chat/turnLifecycle";
import { renameTurnMedia, renameTurnContext } from "../chat/turnSources";
import { currentCitationTargets, extractCitations, invalidateCitationTargets, renameCitationTargets } from "../chat/provenance";
import type { ChatMessage } from "../types";
import type { PluginSettings } from "../types";
import {
  type Conversation,
  type ConversationState,
  getActive,
  newConversation,
  withCliSession,
  saveConversation,
  startConversationTurn,
  deleteConversation as removeConversation,
  renameConversation,
  archiveConversation,
  unarchiveConversation,
  setDistilledNote,
  forkConversation,
  seededConversation,
  setActive,
  touch,
  settleConversationTurn,
  clearConversationTurn,
  excludeTurnMessages,
  type ChatTurnMode,
  type RecoverableEditProposal,
} from "./store";

export interface ConversationsControllerDeps {
  /** The plugin-owned state cell (tests seed it directly, so it stays external). */
  state: {
    get(): ConversationState;
    set(next: ConversationState): void;
  };
  persist: () => Promise<void>;
  activity: () => ActivityStore;
  settings: () => PluginSettings;
  resolveCitation?: (linkpath: string) => string | null;
}

/**
 * Conversation history + turn lifecycle: CRUD, active-turn tracking, and the
 * activity-surface records that survive restarts. Pure store operations come
 * from ./store; this controller adds persistence, sequencing, and activities.
 */
export class ConversationsController {
  private seq = 0;
  private turnLifecycle?: ChatTurnLifecycle;

  constructor(private deps: ConversationsControllerDeps) {}

  private lifecycle(): ChatTurnLifecycle {
    return (this.turnLifecycle ??= new ChatTurnLifecycle());
  }

  private nextId(): string {
    return `c${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
  }

  private maxConversations(): number {
    return this.deps.settings().maxConversations;
  }

  list(): Conversation[] {
    return this.deps.state.get().conversations;
  }

  getActive(): Conversation | null {
    return getActive(this.deps.state.get());
  }

  private withCitationTargets(messages: ChatMessage[], previous: ChatMessage[] = []): ChatMessage[] {
    if (!this.deps.resolveCitation) return messages;
    return messages.map((message, index) => {
      const known = previous[index];
      const targets = currentCitationTargets(known?.citationTargets);
      if (message.role === "assistant" && known?.role === message.role && known.content === message.content && targets) return { ...message, citationTargets: targets };
      if (message.role !== "assistant" || currentCitationTargets(message.citationTargets)) return message;
      const citations = extractCitations(message.content);
      return citations.length ? { ...message, citationTargets: citations.map(citation => ({ ...citation, path: this.deps.resolveCitation!(citation.linkpath) })) } : message;
    });
  }

  /** Update saved references on native file/folder moves, including inactive chats. */
  async renameAttachments(oldPath: string, newPath: string): Promise<void> {
    const state = this.deps.state.get();
    let changed = false;
    const conversations = state.conversations.map((conversation) => {
      let moved = false;
      const messages = conversation.messages.map((message) => {
        const media = Array.isArray(message.media) ? renameTurnMedia(message.media, oldPath, newPath) : message.media;
        const contextAttachments = message.contextAttachments ? renameTurnContext(message.contextAttachments, oldPath, newPath) : undefined;
        const citationTargets = renameCitationTargets(message.citationTargets, oldPath, newPath);
        if (media === message.media && contextAttachments === message.contextAttachments && citationTargets === message.citationTargets) return message;
        changed = moved = true;
        return { ...message, ...(media ? { media } : {}), ...(contextAttachments ? { contextAttachments } : {}), ...(citationTargets ? { citationTargets } : {}) };
      });
      return moved ? { ...conversation, messages } : conversation;
    });
    if (!changed) return;
    this.deps.state.set({ ...state, conversations });
    await this.deps.persist();
  }

  /** Persist deleted sources as unavailable in active and inactive conversations. */
  async invalidateCitations(deletedPath: string): Promise<void> {
    const state = this.deps.state.get();
    let changed = false;
    const conversations = state.conversations.map(conversation => {
      let invalidated = false;
      const messages = conversation.messages.map(message => {
        const citationTargets = invalidateCitationTargets(message.citationTargets, deletedPath);
        if (!citationTargets || citationTargets === message.citationTargets) return message;
        changed = invalidated = true;
        return { ...message, citationTargets };
      });
      return invalidated ? { ...conversation, messages } : conversation;
    });
    if (!changed) return;
    this.deps.state.set({ ...state, conversations });
    await this.deps.persist();
  }

  async beginTurn(
    conversationId: string | null,
    messages: ChatMessage[],
    input: { backend: string; model: string; mode: ChatTurnMode; continuationDepth?: number; regenerating?: boolean },
  ): Promise<{ conversationId: string; turnId: string }> {
    const { state, persist } = this.deps;
    const previousState = state.get();
    const id = conversationId ?? this.nextId();
    messages = this.withCitationTargets(messages, previousState.conversations.find(conversation => conversation.id === id)?.messages);
    const turnId = crypto.randomUUID();
    const now = Date.now();
    const receipt = {
      id: turnId,
      state: "running" as const,
      backend: input.backend,
      model: input.model,
      mode: input.mode,
      userMessageIndex: messages.length - 1,
      createdAt: now,
      updatedAt: now,
      ...(input.continuationDepth !== undefined && input.continuationDepth > 0 ? { continuationDepth: input.continuationDepth } : {}),
      ...(input.regenerating ? { regenerating: true } : {}),
    };
    state.set(startConversationTurn(state.get(), id, messages, receipt, this.maxConversations()));
    // The leaf that starts a turn is the focused leaf — starting a turn makes its conversation active.
    state.set(setActive(state.get(), id));
    try {
      await persist();
    } catch (error) {
      state.set(previousState);
      throw error;
    }
    const title = state.get().conversations.find((c) => c.id === id)?.title ?? "Chat request";
    const activityId = this.activityId(id);
    const activity = this.deps.activity();
    activity.start({ id: activityId, kind: "chat-turn", title });
    activity.update(activityId, {
      currentItem: input.backend === "claude-cli" ? "Claude Code is working" : "Response is running",
      recovery: [
        { id: "open-chat", label: "Open Chat", kind: "open" },
        { id: "stop-chat-turn", label: "Stop", kind: "stop" },
      ],
    });
    return { conversationId: id, turnId };
  }

  registerTurn(conversationId: string, turnId: string, stop: () => void): () => void {
    return this.lifecycle().register(conversationId, turnId, stop);
  }

  /** Record gathered context before backend work, without changing the active conversation. */
  async setTurnContext(conversationId: string, turnId: string, sources: string[]): Promise<boolean> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find(({ id }) => id === conversationId);
    const receipt = conversation?.activeTurn;
    if (!conversation || receipt?.id !== turnId || receipt.state !== "running") return false;
    const index = receipt.userMessageIndex;
    if (conversation.messages[index]?.role !== "user") return false;
    const before = state.get();
    const messages = conversation.messages.map((message, i) => i === index ? { ...message, contextSources: [...sources] } : message);
    const next = saveConversation(before, receipt.regenerating
      ? { ...conversation, activeTurn: { ...receipt, contextSources: [...sources] } }
      : { ...conversation, messages }, 0);
    state.set(next);
    try {
      await persist();
    } catch (error) {
      if (state.get() === next) state.set(before);
      throw error;
    }
    return true;
  }

  async stopTurn(conversationId: string, turnId: string): Promise<void> {
    const { state, persist } = this.deps;
    const turn = state.get().conversations.find(({ id }) => id === conversationId)?.activeTurn;
    if (!turn || turn.id !== turnId || turn.state !== "running") return;
    state.set(excludeTurnMessages(settleConversationTurn(state.get(), conversationId, turnId, "interrupted", Date.now(), "Stopped by user"), conversationId, turnId));
    this.deps.activity().update(this.activityId(conversationId), {
      state: "paused",
      currentItem: "Interrupted — review any partial changes before resuming",
      recovery: [
        { id: "open-chat", label: "Open Chat", kind: "open" },
        { id: "resume-chat-turn", label: "Resume", kind: "resume" },
      ],
    });
    // Stop the live runner synchronously. A stalled save must not keep a CLI
    // process or tool loop running after the user pressed Stop.
    this.lifecycle().stop(conversationId, turnId);
    await persist();
  }

  async completeTurn(conversationId: string, turnId: string, messages: ChatMessage[]): Promise<void> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find(({ id }) => id === conversationId);
    if (!conversation?.activeTurn || conversation.activeTurn.id !== turnId || conversation.activeTurn.state !== "running") return;
    if (conversation.activeTurn.regenerating && messages.at(-1)?.role !== "assistant") {
      await this.interruptTurn(conversationId, turnId, messages, "No replacement answer was received. Previous answer kept.");
      return;
    }
    const previousState = state.get();
    state.set(saveConversation(state.get(), touch(conversation, this.withCitationTargets(messages, conversation.messages), Date.now()), this.maxConversations()));
    state.set(clearConversationTurn(state.get(), conversationId, turnId, Date.now()));
    try {
      await persist();
    } catch (error) {
      state.set(previousState);
      throw error;
    }
    this.deps.activity().dismiss(this.activityId(conversationId));
  }

  /**
   * A turn that hit the tool-iteration cap: work so far is real and stays in
   * context (unlike an interruption), but the receipt survives with its
   * handoff packet so the user — or auto-continue — can pick the task back up.
   */
  async capTurn(conversationId: string, turnId: string, messages: ChatMessage[], handoff?: string): Promise<void> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find(({ id }) => id === conversationId);
    if (!conversation?.activeTurn || conversation.activeTurn.id !== turnId || conversation.activeTurn.state !== "running") return;
    const previousState = state.get();
    const capped = touch(conversation, conversation.activeTurn.regenerating && messages.at(-1)?.role !== "assistant" ? conversation.messages : this.withCitationTargets(messages, conversation.messages), Date.now());
    if (capped.activeTurn?.regenerating) capped.activeTurn = { ...capped.activeTurn, regenerating: false };
    state.set(saveConversation(state.get(), capped, this.maxConversations()));
    state.set(settleConversationTurn(state.get(), conversationId, turnId, "capped", Date.now(), undefined, handoff));
    try {
      await persist();
    } catch (error) {
      state.set(previousState);
      throw error;
    }
    this.deps.activity().update(this.activityId(conversationId), {
      state: "paused",
      currentItem: "Reached the tool-iteration limit — continue when ready",
      recovery: [
        { id: "open-chat", label: "Open Chat", kind: "open" },
        { id: "resume-chat-turn", label: "Continue", kind: "resume" },
      ],
    });
  }

  async interruptTurn(conversationId: string, turnId: string, messages: ChatMessage[], error = "Interrupted"): Promise<void> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find(({ id }) => id === conversationId);
    if (!conversation?.activeTurn || conversation.activeTurn.id !== turnId) return;
    const interruptedMessages = conversation.activeTurn.regenerating ? conversation.messages
      : messages.map((message, index) => index >= conversation.activeTurn!.userMessageIndex ? { ...message, contextExcluded: true } : message);
    state.set(saveConversation(state.get(), touch(conversation, this.withCitationTargets(interruptedMessages, conversation.messages), Date.now()), this.maxConversations()));
    state.set(settleConversationTurn(state.get(), conversationId, turnId, "interrupted", Date.now(), error));
    try {
      await persist();
    } catch (e) {
      console.error("[Claude Companion] failed to persist interrupted turn", e);
    }
    this.deps.activity().update(this.activityId(conversationId), {
      state: "paused",
      currentItem: "Interrupted — review any partial changes before resuming",
      recovery: [
        { id: "open-chat", label: "Open Chat", kind: "open" },
        { id: "resume-chat-turn", label: "Resume", kind: "resume" },
      ],
    });
  }

  private activityId(conversationId: string): string {
    return `chat-turn:${conversationId}`;
  }

  /** Recreate the activity-surface records for turns persisted mid-flight. */
  restoreTurnActivities(): void {
    const activity = this.deps.activity();
    for (const conversation of this.deps.state.get().conversations) {
      if (!conversation.activeTurn) continue;
      const id = this.activityId(conversation.id);
      const capped = conversation.activeTurn.state === "capped";
      activity.start({ id, kind: "chat-turn", title: conversation.title });
      activity.update(id, {
        state: conversation.activeTurn.state === "failed" ? "needs-attention" : "paused",
        currentItem: conversation.activeTurn.error
          ?? (capped ? "Reached the tool-iteration limit — continue when ready" : "Interrupted — review any partial changes before resuming"),
        recovery: [
          { id: "open-chat", label: "Open Chat", kind: "open" },
          { id: "resume-chat-turn", label: capped ? "Continue" : "Resume", kind: "resume" },
        ],
      });
    }
  }

  /** The active conversation id, creating and persisting one when the chat is fresh. */
  activeId(): string {
    const { state } = this.deps;
    const active = getActive(state.get());
    if (active) return active.id;
    const fresh = newConversation(this.nextId(), Date.now());
    state.set(saveConversation(state.get(), fresh, this.maxConversations()));
    return fresh.id;
  }

  /** Switch the active conversation (e.g. from the history picker). */
  async setActive(id: string): Promise<Conversation | null> {
    const { state, persist } = this.deps;
    state.set(setActive(state.get(), id));
    await persist();
    return getActive(state.get());
  }

  /** Set (or clear) the chat project a conversation is scoped to. */
  async setProject(conversationId: string, projectId: string | null): Promise<void> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find((c) => c.id === conversationId);
    if (!conversation) return;
    const updated = { ...conversation };
    if (projectId) updated.projectId = projectId;
    else delete updated.projectId;
    state.set(saveConversation(state.get(), updated, 0));
    await persist();
  }

  async saveEditProposal(conversationId: string, proposal: Omit<RecoverableEditProposal, "proposedAt">): Promise<void> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new Error("Conversation not found for edit recovery.");
    const before = state.get();
    state.set(saveConversation(before, { ...conversation, lastEditProposal: { ...proposal, proposedAt: Date.now() } }, 0));
    try { await persist(); } catch (error) { state.set(before); throw error; }
  }

  async clearEditProposal(conversationId: string): Promise<void> {
    const { state, persist } = this.deps;
    const conversation = state.get().conversations.find((c) => c.id === conversationId);
    if (!conversation?.lastEditProposal) return;
    const updated = { ...conversation };
    delete updated.lastEditProposal;
    state.set(saveConversation(state.get(), updated, 0));
    await persist();
  }

  /** Start a fresh conversation (the current one is already auto-saved). */
  async startNew(): Promise<void> {
    const { state, persist } = this.deps;
    state.set(setActive(state.get(), null));
    await persist();
  }

  async rename(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed.length === 0 || !this.deps.state.get().conversations.some((c) => c.id === id)) return;
    this.deps.state.set(renameConversation(this.deps.state.get(), id, trimmed));
    await this.deps.persist();
  }

  async archive(id: string): Promise<void> {
    this.deps.state.set(archiveConversation(this.deps.state.get(), id, Date.now()));
    await this.deps.persist();
  }

  async unarchive(id: string): Promise<void> {
    this.deps.state.set(unarchiveConversation(this.deps.state.get(), id));
    await this.deps.persist();
  }

  async setDistilledNote(id: string, path: string): Promise<void> {
    this.deps.state.set(setDistilledNote(this.deps.state.get(), id, path));
    await this.deps.persist();
  }

  /** Copy a conversation into a new one; the source and the active slot are untouched. */
  async fork(id: string): Promise<Conversation> {
    const { state, persist } = this.deps;
    const { state: next, fork } = forkConversation(state.get(), id, this.nextId(), Date.now());
    state.set(saveConversation(next, fork, this.maxConversations()));
    await persist();
    return fork;
  }

  async createSeeded(title: string, seed: ChatMessage, projectId?: string): Promise<Conversation> {
    const { state, persist } = this.deps;
    const convo = seededConversation(this.nextId(), Date.now(), title, seed, projectId);
    state.set(saveConversation(state.get(), convo, this.maxConversations()));
    await persist();
    return convo;
  }

  async delete(id: string): Promise<void> {
    const { state, persist } = this.deps;
    state.set(removeConversation(state.get(), id));
    await persist();
  }

  /** Bind a Claude Code session id to a conversation (and its in-flight turn). */
  async setCliSession(conversationId: string, sessionId: string): Promise<void> {
    const { state, persist } = this.deps;
    state.set({
      ...state.get(),
      conversations: state.get().conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const updated = withCliSession(c, sessionId);
        return updated.activeTurn ? { ...updated, activeTurn: { ...updated.activeTurn, cliSessionId: sessionId, updatedAt: Date.now() } } : updated;
      }),
    });
    await persist();
  }
}
