// One chat's conversation state, read and updated by the composer, header, and transcript. Pure.

import type { ChatControls } from "../../claude/chatControls";
import type { ChatProject } from "../../projects/model";
import type { ChatMessage } from "../../types";
import type { TokenUsage } from "../../claude/sse";
import { EMPTY_SESSION, type SessionUsage } from "../../usage/tokens";
import { ChatModeState, type ChatModeDeps } from "./chatMode";

/** The in-flight turn and this chat's token usage. */
export interface TurnState {
  lastBuffer: string;
  turnUsage: TokenUsage | null;
  abort: AbortController | null;
  currentTurn: { conversationId: string; turnId: string } | null;
  session: SessionUsage;
  turnRenderUnsubscribe: (() => void) | null;
  unregisterCurrentTurn: (() => void) | null;
}

export class ChatSession {
  messages: ChatMessage[] = [];
  streaming = false;
  /** Model and knobs for this chat; set when the view opens. */
  controls!: ChatControls;
  /** The chat project this conversation belongs to, if any. */
  project: ChatProject | null = null;
  /** "Allow for this session" on agent write confirmations; cleared with the view. */
  writeGrant = false;
  /** The last prompt sent, for regenerate and edit-and-resend. */
  lastUserText = "";
  readonly turn: TurnState = { lastBuffer: "", turnUsage: null, abort: null, currentTurn: null, session: { ...EMPTY_SESSION }, turnRenderUnsubscribe: null, unregisterCurrentTurn: null };
  readonly mode: ChatModeState;

  constructor(modeDeps: ChatModeDeps) {
    this.mode = new ChatModeState(modeDeps);
  }

  /** A fresh conversation: no messages or usage, outside Plan Mode. */
  clear(): void {
    this.messages = [];
    this.turn.session = { ...EMPTY_SESSION };
    this.mode.reset();
  }
}
