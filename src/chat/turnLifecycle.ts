interface ActiveChatTurn {
  turnId: string;
  stop: () => void;
}

/** Owns live cancellation handles; durable state remains in the conversation store. */
export class ChatTurnLifecycle {
  private readonly active = new Map<string, ActiveChatTurn>();

  register(conversationId: string, turnId: string, stop: () => void): () => void {
    const entry = { turnId, stop };
    this.active.set(conversationId, entry);
    return () => {
      if (this.active.get(conversationId) === entry) this.active.delete(conversationId);
    };
  }

  stop(conversationId: string, turnId: string): boolean {
    const entry = this.active.get(conversationId);
    if (!entry || entry.turnId !== turnId) return false;
    this.active.delete(conversationId);
    entry.stop();
    return true;
  }
}
