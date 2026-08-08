/** Injectable timer boundary keeps Inbox refresh behavior deterministic in tests. */
export interface InboxRefreshTimers<Timer> {
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface InboxRefreshController {
  /** Debounce a request to render the Inbox. */
  request(): void;
  /** Start a render generation, invalidating any earlier async scan. */
  nextGeneration(): number;
  /** Whether an async scan still belongs to the latest open view generation. */
  isCurrent(generation: number): boolean;
  /** Cancel queued work and invalidate in-flight async scans. */
  dispose(): void;
}

/** Coalesces vault events while letting an Inbox view reject stale async work. */
export function createInboxRefreshController<Timer>(
  render: () => void,
  timers: InboxRefreshTimers<Timer>,
  debounceMs: number,
): InboxRefreshController {
  let scheduled: Timer | null = null;
  let generation = 0;
  let disposed = false;

  const clearScheduled = () => {
    if (scheduled === null) return;
    timers.clearTimeout(scheduled);
    scheduled = null;
  };

  return {
    request() {
      if (disposed) return;
      clearScheduled();
      scheduled = timers.setTimeout(() => {
        scheduled = null;
        if (!disposed) render();
      }, debounceMs);
    },
    nextGeneration() {
      generation++;
      return generation;
    },
    isCurrent(candidate) {
      return !disposed && candidate === generation;
    },
    dispose() {
      disposed = true;
      clearScheduled();
      generation++;
    },
  };
}
