import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";

describe("ActivityStore", () => {
  it("removes successful activity after a readable confirmation window", () => {
    vi.useFakeTimers();
    try {
      const store = new ActivityStore();
      const id = store.start({ id: "index", kind: "semantic-index", title: "Building semantic index", total: 2 });

      store.finish(id, { completed: 2, succeeded: 2 });
      vi.advanceTimersByTime(3_999);
      expect(store.snapshot().records).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(store.snapshot().records).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps failures visible and cancels stale success cleanup when an id is reused", () => {
    vi.useFakeTimers();
    try {
      const store = new ActivityStore();
      const id = store.start({ id: "index", kind: "semantic-index", title: "Building semantic index", total: 1 });
      store.finish(id, { completed: 1, succeeded: 1 });

      store.start({ id, kind: "semantic-index", title: "Rebuilding semantic index", total: 2 });
      vi.advanceTimersByTime(4_000);
      expect(store.snapshot().records[0]).toMatchObject({ id, state: "running", title: "Rebuilding semantic index" });

      store.finish(id, { completed: 2, succeeded: 2 });
      vi.advanceTimersByTime(3_999);
      store.fail(id, {
        failed: 1,
        recovery: [{ id: "retry", label: "Retry indexing", kind: "retry" }],
      });
      vi.advanceTimersByTime(40_001);
      expect(store.snapshot().records[0]).toMatchObject({ id, state: "needs-attention", failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending success cleanup when the store is disposed", () => {
    vi.useFakeTimers();
    try {
      const store = new ActivityStore();
      const id = store.start({ id: "index", kind: "semantic-index", title: "Building semantic index" });
      store.finish(id);
      expect(vi.getTimerCount()).toBe(1);

      store.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      expect(store.snapshot()).toEqual({ records: [], disposed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches a regression that appends progress events instead of updating one activity", () => {
    let now = 100;
    const store = new ActivityStore({ now: () => now });
    const id = store.start({ id: "source-enrichment:inbox-batch", kind: "source-enrichment", title: "Enriching Inbox", total: 4 });

    now = 110;
    store.update(id, { completed: 1, succeeded: 1, currentItem: "one.md" });
    now = 120;
    store.update(id, { completed: 2, succeeded: 1, failed: 1, currentItem: "two.md" });

    expect(store.snapshot().records).toHaveLength(1);
    expect(store.snapshot().records[0]).toMatchObject({
      id,
      state: "running",
      completed: 2,
      total: 4,
      percent: 50,
      succeeded: 1,
      failed: 1,
      currentItem: "two.md",
      createdAt: 100,
      updatedAt: 120,
    });
  });

  it("catches a regression that invents a percentage for indeterminate work", () => {
    const store = new ActivityStore();
    const id = store.start({ kind: "embedding-download", title: "Downloading model" });
    store.update(id, { completed: 3 });

    expect(store.snapshot().records[0]).toMatchObject({ completed: 3 });
    expect(store.snapshot().records[0]?.percent).toBeUndefined();
  });

  it("catches a regression that leaks subscribers after a view unsubscribes", () => {
    const store = new ActivityStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.start({ id: "index", kind: "semantic-index", title: "Building index", total: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("catches unbounded activity records, details, and messages", () => {
    const store = new ActivityStore({ maxRecords: 2, maxDetails: 2, maxMessageLength: 12 });
    const first = store.start({ id: "first", kind: "link-review", title: "First activity title" });
    store.update(first, {
      details: [
        { label: "one", message: "first long detail", state: "success" },
        { label: "two", message: "second long detail", state: "error" },
        { label: "three", message: "third long detail", state: "success" },
      ],
      technicalDetails: "Bearer secret\nwith many extra characters",
    });
    store.start({ id: "second", kind: "semantic-index", title: "Second activity" });
    store.start({ id: "third", kind: "embedding-download", title: "Third activity" });

    const snapshot = store.snapshot();
    expect(snapshot.records.map(({ id }) => id)).toEqual(["third", "second"]);
    expect(snapshot.records.every(({ title }) => title.length <= 12)).toBe(true);

    const bounded = new ActivityStore({ maxRecords: 2, maxDetails: 2, maxMessageLength: 12 });
    const boundedId = bounded.start({ id: "bounded", kind: "link-review", title: "Bounded" });
    bounded.update(boundedId, {
      details: [
        { label: "one", message: "first long detail", state: "success" },
        { label: "two", message: "second long detail", state: "error" },
        { label: "three", message: "third long detail", state: "success" },
      ],
      technicalDetails: "Bearer secret\nwith many extra characters",
    });
    expect(bounded.snapshot().records[0]?.details.map(({ label }) => label)).toEqual(["two", "three"]);
    expect(bounded.snapshot().records[0]?.details.every(({ message }) => message.length <= 12)).toBe(true);
    expect(bounded.snapshot().records[0]?.technicalDetails).toHaveLength(12);
  });

  it("catches incorrect terminal and dismissal transitions", () => {
    const store = new ActivityStore();
    const success = store.start({ id: "success", kind: "semantic-index", title: "Index", total: 2 });
    store.finish(success, { completed: 2, succeeded: 2 });
    const failure = store.start({ id: "failure", kind: "source-enrichment", title: "Inbox", total: 2 });
    store.fail(failure, { completed: 2, succeeded: 1, failed: 1, recovery: [{ id: "retry", label: "Retry", kind: "retry" }] });

    expect(store.snapshot().records.find(({ id }) => id === success)?.state).toBe("succeeded");
    expect(store.snapshot().records.find(({ id }) => id === failure)).toMatchObject({ state: "needs-attention", percent: 100 });

    store.dismiss(failure);
    expect(store.snapshot().records.some(({ id }) => id === failure)).toBe(false);
  });

  it("catches late progress publication after plugin disposal", () => {
    const store = new ActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const id = store.start({ id: "index", kind: "semantic-index", title: "Index", total: 3 });
    store.dispose();
    const callsAfterDispose = listener.mock.calls.length;

    store.update(id, { completed: 3 });
    store.start({ id: "late", kind: "semantic-index", title: "Late" });

    expect(listener).toHaveBeenCalledTimes(callsAfterDispose);
    expect(store.snapshot()).toEqual({ records: [], disposed: true });
  });
});
