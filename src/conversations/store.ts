// Pure (Obsidian-free) conversation store. Holds saved chats so they survive
// app restarts and can be resumed from a session list. All functions are
// immutable and side-effect-free — the plugin owns persistence and supplies
// ids/timestamps so this stays unit-testable.

import type { ChatMessage } from "../types";

export interface Conversation {
  id: string;
  title: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; conversations are ordered by this, most-recent first. */
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ConversationState {
  /** Most-recently-updated first. */
  conversations: Conversation[];
  activeId: string | null;
}

const UNTITLED = "New conversation";

export function emptyState(): ConversationState {
  return { conversations: [], activeId: null };
}

/** Derive a human title from the first user message (or fall back). */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim().length > 0);
  if (!firstUser) return UNTITLED;
  const line = firstUser.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  const cleaned = line
    .replace(/^#+\s*/, "") // strip markdown heading marks
    .replace(/[*_`>]/g, "") // strip light markdown emphasis
    .trim();
  if (cleaned.length === 0) return UNTITLED;
  return cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}…` : cleaned;
}

export function newConversation(id: string, now: number): Conversation {
  return { id, title: UNTITLED, createdAt: now, updatedAt: now, messages: [] };
}

export function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (prev?.role === "assistant" && message.role === "assistant") continue;
    out.push({ ...message });
  }
  return out;
}

/**
 * Coalesce a message list into strictly alternating roles for the Anthropic
 * Messages API, merging consecutive same-role messages (the API 400s on two in
 * a row). Guards the case where a failed turn left a trailing `user` message and
 * the next send appended another `user` message.
 */
export function toApiMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/**
 * Return a copy of `convo` updated with the given messages and timestamp.
 * Re-derives the title while it is still untitled so the first real exchange
 * names the session.
 */
export function touch(convo: Conversation, messages: ChatMessage[], now: number): Conversation {
  const cloned = compactMessages(messages);
  const title = convo.title === UNTITLED ? deriveTitle(cloned) : convo.title;
  return { ...convo, messages: cloned, title, updatedAt: now };
}

/**
 * Insert or replace `convo`, keep the list ordered by recency, prune to
 * `maxKeep`, and mark it active. `maxKeep <= 0` means unbounded.
 */
export function saveConversation(state: ConversationState, convo: Conversation, maxKeep: number): ConversationState {
  const others = state.conversations.filter((c) => c.id !== convo.id);
  const merged = [convo, ...others].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = maxKeep > 0 ? merged.slice(0, maxKeep) : merged;
  // If the active conversation was pruned out, clear it.
  const activeId = kept.some((c) => c.id === convo.id) ? convo.id : kept[0]?.id ?? null;
  return { conversations: kept, activeId };
}

export function deleteConversation(state: ConversationState, id: string): ConversationState {
  const conversations = state.conversations.filter((c) => c.id !== id);
  const activeId = state.activeId === id ? (conversations[0]?.id ?? null) : state.activeId;
  return { conversations, activeId };
}

export function renameConversation(state: ConversationState, id: string, title: string): ConversationState {
  const trimmed = title.trim() || UNTITLED;
  return {
    ...state,
    conversations: state.conversations.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
  };
}

export function getActive(state: ConversationState): Conversation | null {
  if (!state.activeId) return null;
  return state.conversations.find((c) => c.id === state.activeId) ?? null;
}

export function setActive(state: ConversationState, id: string | null): ConversationState {
  if (id !== null && !state.conversations.some((c) => c.id === id)) return state;
  return { ...state, activeId: id };
}

/** Coerce loosely-typed persisted JSON back into a valid state. */
export function fromPersisted(raw: unknown): ConversationState {
  if (!raw || typeof raw !== "object") return emptyState();
  const o = raw as { conversations?: unknown; activeId?: unknown };
  const conversations = Array.isArray(o.conversations)
    ? o.conversations.filter(isConversation).map((c) => ({ ...c, messages: compactMessages(c.messages) }))
    : [];
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  const activeId = typeof o.activeId === "string" && conversations.some((c) => c.id === o.activeId) ? o.activeId : conversations[0]?.id ?? null;
  return { conversations, activeId };
}

/** Compact relative time for the history list: "just now", "5m ago", "2d ago", or a date. */
export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

function isConversation(v: unknown): v is Conversation {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<Conversation>;
  return (
    typeof c.id === "string" &&
    typeof c.title === "string" &&
    typeof c.createdAt === "number" &&
    typeof c.updatedAt === "number" &&
    Array.isArray(c.messages) &&
    c.messages.every((m) => m && typeof (m as ChatMessage).role === "string" && typeof (m as ChatMessage).content === "string")
  );
}
