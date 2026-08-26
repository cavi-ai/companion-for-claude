/**
 * Runs tasks one at a time while coalescing concurrent work for the same key.
 *
 * A rejected task never poisons the serial lane. Callers sharing a key receive
 * the same promise, so they also observe the same result or failure.
 */
export class KeyedSerialQueue<Key, Result> {
  private tail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<Key, Promise<Result>>();

  run(key: Key, task: () => Promise<Result>): Promise<Result> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(key, result);
    void result.then(
      () => this.deleteIfCurrent(key, result),
      () => this.deleteIfCurrent(key, result),
    );
    return result;
  }

  private deleteIfCurrent(key: Key, task: Promise<Result>): void {
    if (this.inFlight.get(key) === task) this.inFlight.delete(key);
  }
}
