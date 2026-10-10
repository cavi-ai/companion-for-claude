// The CLI sessions open for chat conversations: one per conversation, reused while its signature holds
// and the process is alive, at most `capacity` open with the least recently used idle one closed first.
// Closing a session then runs its entry's release. Calls for one conversation run in order, so a close
// waits for that conversation's open and a second acquire reuses the first one's session. Pure; opening
// is injected.

export interface PooledSession {
  isBusy(): boolean;
  isClosed(): boolean;
  interrupt(): void;
  close(): Promise<void>;
}

/** What `open` returns: the session plus the cleanup for everything opened with it. */
export interface PoolEntry<S extends PooledSession> {
  session: S;
  release(): Promise<void>;
}

export class CliSessionPool<S extends PooledSession> {
  private readonly entries = new Map<string, { entry: PoolEntry<S>; session: S; signature: string; lastUsed: number }>();
  /** The last queued call per conversation. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The conversation's open session when its signature matches and it is alive; otherwise the old one is
   * closed, idle sessions over capacity are evicted, and `open` supplies a new one. `fresh` always opens.
   * When `open` throws nothing is stored; `open` releases what it opened.
   */
  acquire(id: string, signature: string, open: () => Promise<PoolEntry<S>>, opts: { fresh?: boolean } = {}): Promise<S> {
    return this.enqueue(id, () => this.acquireNow(id, signature, open, opts));
  }

  interrupt(id: string): void {
    this.entries.get(id)?.session.interrupt();
  }

  /** Close the conversation's session after any call already queued for it. */
  close(id: string): Promise<void> {
    return this.enqueue(id, () => this.closeNow(id));
  }

  /** Close every session, including ones still opening. */
  async closeAll(): Promise<void> {
    for (const id of new Set([...this.queues.keys(), ...this.entries.keys()])) await this.close(id);
  }

  private enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.queues.set(id, next);
    const settle = (): void => {
      if (this.queues.get(id) === next) this.queues.delete(id);
    };
    next.then(settle, settle);
    return next;
  }

  private async acquireNow(id: string, signature: string, open: () => Promise<PoolEntry<S>>, opts: { fresh?: boolean }): Promise<S> {
    const existing = this.entries.get(id);
    if (!opts.fresh && existing && existing.signature === signature && !existing.session.isClosed()) {
      existing.lastUsed = this.now();
      return existing.session;
    }
    if (existing) await this.closeNow(id);
    while (this.entries.size >= this.capacity) {
      const idle = [...this.entries].filter(([, held]) => !held.session.isBusy()).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) break;
      await this.closeNow(idle[0]);
    }
    const entry = await open();
    this.entries.set(id, { entry, session: entry.session, signature, lastUsed: this.now() });
    return entry.session;
  }

  private async closeNow(id: string): Promise<void> {
    const held = this.entries.get(id);
    if (!held) return;
    this.entries.delete(id);
    await held.session.close();
    await held.entry.release();
  }
}
