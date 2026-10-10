import { describe, expect, it, vi } from "vitest";
import { CliSessionPool, type PoolEntry } from "../../src/cli/sessionPool";

class FakeSession {
  busy = false;
  closed = false;
  isBusy = () => this.busy;
  isClosed = () => this.closed;
  interrupt = vi.fn();
  close = vi.fn(async () => { this.closed = true; });
}

function harness(capacity = 3) {
  let clock = 0;
  const events: string[] = [];
  const pool = new CliSessionPool<FakeSession>(capacity, () => ++clock);
  const opener = (name: string) => vi.fn(async (): Promise<PoolEntry<FakeSession>> => {
    const session = new FakeSession();
    session.close.mockImplementation(async () => { session.closed = true; events.push(`close ${name}`); });
    return { session, release: async () => { events.push(`release ${name}`); } };
  });
  return { pool, opener, events };
}

describe("CliSessionPool", () => {
  it("reuses the conversation's session while the signature matches", async () => {
    const { pool, opener } = harness();
    const open = opener("a");
    const first = await pool.acquire("c1", "sig", open);
    await expect(pool.acquire("c1", "sig", open)).resolves.toBe(first);
    expect(open).toHaveBeenCalledOnce();
  });

  it("closes then releases the old session before opening one for a new signature", async () => {
    const { pool, opener, events } = harness();
    const first = await pool.acquire("c1", "chat", opener("old"));
    const next = await pool.acquire("c1", "plan", opener("new"));
    expect(next).not.toBe(first);
    expect(events).toEqual(["close old", "release old"]);
  });

  it("opens a new session when the old one is spent or a fresh one is asked for", async () => {
    const { pool, opener } = harness();
    const first = await pool.acquire("c1", "sig", opener("a"));
    first.closed = true;
    const second = await pool.acquire("c1", "sig", opener("b"));
    expect(second).not.toBe(first);
    const third = await pool.acquire("c1", "sig", opener("c"), { fresh: true });
    expect(third).not.toBe(second);
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("evicts the least recently used idle session at capacity and never a busy one", async () => {
    const { pool, opener, events } = harness(2);
    const a = await pool.acquire("a", "sig", opener("a"));
    await pool.acquire("b", "sig", opener("b"));
    a.busy = true;
    await pool.acquire("a", "sig", opener("unused"));
    await pool.acquire("c", "sig", opener("c"));
    expect(events).toEqual(["close b", "release b"]);
    expect(a.close).not.toHaveBeenCalled();
  });

  it("evicts by recency: a session reused a moment ago outlives an older idle one", async () => {
    const { pool, opener, events } = harness(2);
    await pool.acquire("a", "sig", opener("a"));
    await pool.acquire("b", "sig", opener("b"));
    await pool.acquire("a", "sig", opener("unused"));
    await pool.acquire("c", "sig", opener("c"));
    expect(events).toEqual(["close b", "release b"]);
  });

  it("does not count a closing session toward capacity", async () => {
    const { pool, opener, events } = harness(2);
    const a = await pool.acquire("a", "sig", opener("a"));
    await pool.acquire("b", "sig", opener("b"));
    let finishClose!: () => void;
    a.close.mockImplementation(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    const closing = pool.close("a");
    await pool.acquire("c", "sig", opener("c"));
    finishClose();
    await closing;
    expect(events).toEqual(["release a"]);
  });

  it("closes and releases a session that was still opening when everything closed", async () => {
    const { pool, events } = harness();
    let finishOpen!: () => void;
    const session = new FakeSession();
    const opening = pool.acquire("c1", "sig", async () => {
      await new Promise<void>((resolve) => { finishOpen = resolve; });
      return { session, release: async () => { events.push("release"); } };
    });
    await Promise.resolve();
    const closing = pool.closeAll();
    finishOpen();
    await expect(opening).resolves.toBe(session);
    await closing;
    expect(session.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["release"]);
  });

  it("gives a second caller the session the first caller is still opening", async () => {
    const { pool, opener } = harness();
    const open = opener("a");
    const [first, second] = await Promise.all([pool.acquire("c1", "sig", open), pool.acquire("c1", "sig", open)]);
    expect(second).toBe(first);
    expect(open).toHaveBeenCalledOnce();
  });

  it("grows past capacity when every open session is busy", async () => {
    const { pool, opener, events } = harness(1);
    const a = await pool.acquire("a", "sig", opener("a"));
    a.busy = true;
    await pool.acquire("b", "sig", opener("b"));
    expect(events).toEqual([]);
    await pool.closeAll();
    expect(events).toEqual(["close a", "release a", "close b", "release b"]);
  });

  it("stores nothing when opening fails", async () => {
    const { pool, opener } = harness();
    const old = await pool.acquire("c1", "chat", opener("old"));
    await expect(pool.acquire("c1", "plan", async () => { throw new Error("bridge did not bind"); })).rejects.toThrow("bridge did not bind");
    expect(old.close).toHaveBeenCalledOnce();
    const open = opener("again");
    await pool.acquire("c1", "plan", open);
    expect(open).toHaveBeenCalledOnce();
  });

  it("interrupts and closes only the named conversation", async () => {
    const { pool, opener, events } = harness();
    const a = await pool.acquire("a", "sig", opener("a"));
    const b = await pool.acquire("b", "sig", opener("b"));
    pool.interrupt("a");
    pool.interrupt("missing");
    expect(a.interrupt).toHaveBeenCalledOnce();
    expect(b.interrupt).not.toHaveBeenCalled();
    await pool.close("b");
    await pool.close("b");
    expect(events).toEqual(["close b", "release b"]);
  });
});
