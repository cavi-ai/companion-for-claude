// Adapter B: turn an in-Obsidian Companion chat (ChatMessage[]) into the same
// SessionDigest shape the CLI-transcript path produces, so a conversation can be
// captured into the memory system (sanitized + filed in the memory folder, shown
// in the Memory sidebar) exactly like a Claude Code session. Pure / Obsidian-free.

import type { ChatMessage } from "../types";
import type { SessionDigest } from "./transcript";

export interface ConversationMeta {
  /** Stable id (the conversation id) — the idempotency key for re-capture. */
  sessionId?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
}

/** Build a digest from a chat. No tool actions / files (an in-app chat has none). */
export function digestConversation(messages: ChatMessage[], meta: ConversationMeta = {}): SessionDigest {
  const prose: SessionDigest["prose"] = [];
  let userTurns = 0;
  let assistantTurns = 0;
  for (const m of messages) {
    const text = (m.content ?? "").trim();
    if (!text) continue;
    prose.push({ role: m.role, text });
    if (m.role === "user") userTurns += 1;
    else assistantTurns += 1;
  }
  return {
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
    ...(meta.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
    userTurns,
    assistantTurns,
    prose,
    toolActions: [],
    filesTouched: [],
    inputTokens: 0,
    outputTokens: 0,
  };
}
