import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { ORDER_NOTE_SETTLE_MS, OrdersController, type OrdersControllerDeps } from "../../src/orders/controller";
import type { QueuedEdit } from "../../src/orders/editQueue";
import type { NoteFacts } from "../../src/orders/match";
import type { StandingOrder } from "../../src/orders/order";
import type { OrderRunResult, OrderTrigger } from "../../src/orders/runner";
import type { OrdersState } from "../../src/orders/state";

const HOUR = 3_600_000;
const START = new Date(2026, 9, 7, 10, 0).getTime();

const noteOrder: StandingOrder = { id: "Claude/Templates/Follow ups.md", name: "Follow ups", path: "Claude/Templates/Follow ups.md", prompt: "p", enabled: true, onNote: { folder: "Meetings" } };
const scheduled: StandingOrder = { id: "Claude/Templates/Daily.md", name: "Daily", path: "Claude/Templates/Daily.md", prompt: "p", enabled: true, schedule: { kind: "daily", hour: 8, minute: 0 } };

interface Harness {
  deps: OrdersControllerDeps;
  controller: OrdersController;
  clock: { ms: number };
  runs: Array<{ order: StandingOrder; trigger: OrderTrigger }>;
  written: Array<{ path: string; content: string }>;
  activity: ActivityStore;
  state: { value: OrdersState };
  queue: { value: QueuedEdit[] };
  queueChanged: ReturnType<typeof vi.fn>;
  facts: Map<string, NoteFacts>;
  notes: Map<string, string>;
  orders: StandingOrder[];
}

function harness(opts: { orders?: StandingOrder[]; enabled?: boolean; run?: (order: StandingOrder, trigger: OrderTrigger) => Promise<OrderRunResult>; invalid?: Array<{ path: string; reason: string }> } = {}): Harness {
  const clock = { ms: START };
  const runs: Harness["runs"] = [];
  const written: Harness["written"] = [];
  const state = { value: {} as OrdersState };
  const queue = { value: [] as QueuedEdit[] };
  const facts = new Map<string, NoteFacts>();
  const notes = new Map<string, string>();
  const orders = opts.orders ?? [noteOrder];
  const activity = new ActivityStore();
  const queueChanged = vi.fn();
  const deps: OrdersControllerDeps = {
    enabled: () => opts.enabled ?? true,
    now: () => new Date(clock.ms),
    loadOrders: async () => ({ orders: [...orders], invalid: opts.invalid ?? [] }),
    excludedRoots: () => ["Claude/Templates", "Claude/Orders"],
    noteFacts: (path) => facts.get(path) ?? null,
    readNote: async (path) => notes.get(path) ?? `content of ${path}`,
    writeRunNote: async (path, content) => { written.push({ path, content }); return path; },
    run: async (order, trigger) => {
      runs.push({ order, trigger });
      return opts.run ? opts.run(order, trigger) : { text: "ok", proposals: [] };
    },
    getState: () => state.value,
    setState: async (next) => { state.value = next; },
    getQueue: () => queue.value,
    setQueue: async (next) => { queue.value = next; },
    activity,
    onQueueChanged: queueChanged,
  };
  return { deps, controller: new OrdersController(deps), clock, runs, written, activity, state, queue, queueChanged, facts, notes, orders };
}

const fact = (h: Harness, path: string, ctime = START + 1000): void => { h.facts.set(path, { path, ctime, tags: [] }); };
/** A note event, then the settle window passing, then the 60s tick that promotes it. */
const settleAndTick = async (h: Harness): Promise<void> => { h.clock.ms += ORDER_NOTE_SETTLE_MS; await h.controller.tick(); };

describe("OrdersController note events", () => {
  it("runs once for a new matching note, writes the run note and finishes the activity", async () => {
    const h = harness({ run: async () => ({ text: "Found one.", proposals: [{ path: "Meetings/a.md", edits: [{ old_str: "a", new_str: "b" }], description: "Mark shipped" }] }) });
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await h.controller.noteEvent("Meetings/a.md");
    expect(h.runs).toHaveLength(0);
    await settleAndTick(h);

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.trigger).toEqual({ kind: "note", path: "Meetings/a.md", content: "content of Meetings/a.md" });
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.path).toMatch(/^Claude\/Orders\/Follow ups\/2026-10-07 1001\.md$/);
    expect(h.written[0]?.content).toContain("type: \"order-run\"");
    expect(h.queue.value).toHaveLength(1);
    expect(h.queue.value[0]).toMatchObject({ id: `${h.written[0]?.path}#0`, orderId: noteOrder.id, orderName: "Follow ups", path: "Meetings/a.md", description: "Mark shipped" });
    expect(h.queueChanged).toHaveBeenCalled();
    const record = h.activity.snapshot().records[0];
    expect(record).toMatchObject({ kind: "standing-order", title: "Follow ups", state: "succeeded", currentItem: "Meetings/a.md" });
  });

  it("does nothing when the setting is off", async () => {
    const h = harness({ enabled: false });
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);
  });

  it("does nothing for a disabled order", async () => {
    const h = harness({ orders: [{ ...noteOrder, enabled: false }] });
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);
  });

  it("never runs for notes that existed when the order was armed", async () => {
    const h = harness();
    await h.controller.refresh();
    for (let i = 0; i < 5; i++) fact(h, `Meetings/old${i}.md`, START - 1000 - i);
    for (let i = 0; i < 5; i++) await h.controller.noteEvent(`Meetings/old${i}.md`);
    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);
  });

  it("does not trigger on its own output note", async () => {
    const h = harness({ orders: [{ ...noteOrder, onNote: { tag: "order-run" } }] });
    await h.controller.refresh();
    h.facts.set("Claude/Orders/Follow ups/r.md", { path: "Claude/Orders/Follow ups/r.md", ctime: START + 5, tags: ["order-run"] });
    await h.controller.noteEvent("Claude/Orders/Follow ups/r.md");
    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);
  });

  it("ignores paths that are not markdown notes", async () => {
    const h = harness();
    await h.controller.refresh();
    await h.controller.noteEvent("Meetings/photo.png");
    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);
  });

  it("fires once per order and path however many events arrive", async () => {
    const h = harness();
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await Promise.all([h.controller.noteEvent("Meetings/a.md"), h.controller.noteEvent("Meetings/a.md")]);
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    await settleAndTick(h);
    expect(h.runs).toHaveLength(1);
  });

  it("never runs an empty note, and re-arms it on its next change", async () => {
    const h = harness();
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    h.notes.set("Meetings/a.md", "---\ntags: [x]\n---\n  \n");
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);
    expect(Object.values(h.state.value)[0]?.fired).toEqual([]);

    await settleAndTick(h);
    expect(h.runs).toHaveLength(0);

    h.notes.set("Meetings/a.md", "---\ntags: [x]\n---\nNotes from standup\n");
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.trigger).toMatchObject({ kind: "note", path: "Meetings/a.md" });
  });

  it("waits for a quiet minute: a change at 50s restarts the timer", async () => {
    const h = harness();
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await h.controller.noteEvent("Meetings/a.md");
    h.clock.ms += 50_000;
    await h.controller.tick();
    await h.controller.noteEvent("Meetings/a.md");
    h.clock.ms += 10_000;
    await h.controller.tick();
    expect(h.runs).toHaveLength(0);
    h.clock.ms += 49_999;
    await h.controller.tick();
    expect(h.runs).toHaveLength(0);
    h.clock.ms += 1;
    await h.controller.tick();
    expect(h.runs).toHaveLength(1);
  });

  it("caps note runs at ten per hour and runs the held one after the hour advances", async () => {
    const h = harness();
    await h.controller.refresh();
    h.clock.ms = Math.floor(START / HOUR) * HOUR + 60_000;
    for (let i = 0; i < 11; i++) fact(h, `Meetings/n${i}.md`, h.clock.ms + 1000);
    for (let i = 0; i < 11; i++) await h.controller.noteEvent(`Meetings/n${i}.md`);
    await settleAndTick(h);
    expect(h.runs).toHaveLength(10);
    await h.controller.tick();
    expect(h.runs).toHaveLength(10);
    h.clock.ms += HOUR;
    await h.controller.tick();
    expect(h.runs).toHaveLength(11);
    expect(h.runs[10]?.trigger).toMatchObject({ kind: "note", path: "Meetings/n10.md" });
  });

  it("runs one at a time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ run: async () => { await gate; return { text: "ok", proposals: [] }; } });
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    fact(h, "Meetings/b.md");
    await h.controller.noteEvent("Meetings/a.md");
    await h.controller.noteEvent("Meetings/b.md");
    h.clock.ms += ORDER_NOTE_SETTLE_MS;
    const ticking = h.controller.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runs).toHaveLength(1);
    release();
    await ticking;
    expect(h.runs).toHaveLength(2);
  });
});

describe("OrdersController failures", () => {
  it("marks a failed run needs-attention with Retry and Open, still writes the note, and retry re-runs the same trigger", async () => {
    let fail = true;
    const h = harness({ run: async () => (fail ? { text: "", proposals: [], error: new Error("rate limited") } : { text: "ok", proposals: [] }) });
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);

    const record = h.activity.snapshot().records[0]!;
    expect(record.state).toBe("needs-attention");
    expect(record.recovery.map((a) => a.id)).toEqual(["retry", "open"]);
    expect(record.details[0]?.message).toBe("rate limited");
    expect(h.written[0]?.content).toContain("Run failed: rate limited");

    fail = false;
    h.clock.ms += 120_000;
    await h.controller.retry(record.id);
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]?.trigger).toMatchObject({ kind: "note", path: "Meetings/a.md" });
    expect(h.activity.snapshot().records.find((r) => r.id === record.id)?.state).toBe("succeeded");
    await expect(h.controller.retry(record.id)).rejects.toThrow("no longer be retried");
  });

  it("treats a thrown run as a failure", async () => {
    const h = harness({ run: async () => { throw new Error("boom"); } });
    await h.controller.refresh();
    fact(h, "Meetings/a.md");
    await h.controller.noteEvent("Meetings/a.md");
    await settleAndTick(h);
    expect(h.activity.snapshot().records[0]).toMatchObject({ state: "needs-attention" });
  });
});

describe("OrdersController schedule", () => {
  it("runs a due order once per slot", async () => {
    const h = harness({ orders: [scheduled] });
    await h.controller.refresh();
    h.clock.ms = new Date(2026, 9, 8, 8, 1).getTime();
    await h.controller.tick();
    await h.controller.tick();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.trigger).toEqual({ kind: "schedule" });
    h.clock.ms = new Date(2026, 9, 9, 8, 1).getTime();
    await h.controller.tick();
    expect(h.runs).toHaveLength(2);
  });

  it("does not run for slots before the order was armed", async () => {
    const h = harness({ orders: [scheduled] });
    await h.controller.refresh();
    await h.controller.tick();
    expect(h.runs).toHaveLength(0);
  });

  it("runNow runs regardless of enabled state", async () => {
    const h = harness({ orders: [{ ...scheduled, enabled: false }], enabled: false });
    await h.controller.refresh();
    await h.controller.runNow(scheduled.id);
    expect(h.runs).toHaveLength(1);
    await expect(h.controller.runNow("missing.md")).rejects.toThrow("not found");
  });
});

describe("OrdersController registry", () => {
  it("exposes valid and invalid orders from the last refresh", async () => {
    const invalid = [{ path: "Claude/Templates/Bad.md", reason: "bad" }];
    const h = harness({ invalid });
    await h.controller.refresh();
    expect(h.controller.validOrders()).toEqual([noteOrder]);
    expect(h.controller.invalidOrders()).toEqual(invalid);
  });

  it("drops state for orders that are no longer enabled", async () => {
    const orders = [noteOrder];
    const h = harness({ orders });
    await h.controller.refresh();
    expect(Object.keys(h.state.value)).toEqual([noteOrder.id]);
    orders.length = 0;
    await h.controller.refresh();
    expect(h.state.value).toEqual({});
  });
});

describe("OrdersController disabling", () => {
  function gated() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { gate, release: () => release() };
  }

  async function queueBehindRunning(h: Harness, hold: Promise<void>): Promise<{ done: Promise<void>; started: () => number }> {
    fact(h, "Meetings/a.md");
    fact(h, "Meetings/b.md");
    await h.controller.noteEvent("Meetings/a.md");
    await h.controller.noteEvent("Meetings/b.md");
    h.clock.ms += ORDER_NOTE_SETTLE_MS;
    const done = h.controller.tick();
    await new Promise((r) => setTimeout(r, 5));
    void hold;
    return { done, started: () => h.runs.length };
  }

  it("never starts a queued run once its order is disabled", async () => {
    const g = gated();
    const h = harness({ run: async () => { await g.gate; return { text: "ok", proposals: [] }; } });
    await h.controller.refresh();
    const q = await queueBehindRunning(h, g.gate);
    expect(q.started()).toBe(1);
    h.orders[0] = { ...noteOrder, enabled: false };
    await h.controller.refresh();
    g.release();
    await q.done;
    expect(h.runs).toHaveLength(1);
  });

  it("never starts a queued run once its order note is deleted", async () => {
    const g = gated();
    const h = harness({ run: async () => { await g.gate; return { text: "ok", proposals: [] }; } });
    await h.controller.refresh();
    const q = await queueBehindRunning(h, g.gate);
    h.orders.length = 0;
    await h.controller.refresh();
    g.release();
    await q.done;
    expect(h.runs).toHaveLength(1);
  });

  it("drops held runs when the order is disabled", async () => {
    const h = harness();
    await h.controller.refresh();
    h.clock.ms = Math.floor(START / HOUR) * HOUR + 60_000;
    for (let i = 0; i < 11; i++) { fact(h, `Meetings/n${i}.md`, h.clock.ms + 1000); await h.controller.noteEvent(`Meetings/n${i}.md`); }
    await settleAndTick(h);
    expect(h.runs).toHaveLength(10);
    h.orders[0] = { ...noteOrder, enabled: false };
    await h.controller.refresh();
    h.clock.ms += HOUR;
    await h.controller.tick();
    expect(h.runs).toHaveLength(10);
  });

  it("still runs a disabled order on demand", async () => {
    const h = harness({ orders: [{ ...noteOrder, enabled: false }] });
    await h.controller.refresh();
    await h.controller.runNow(noteOrder.id);
    expect(h.runs).toHaveLength(1);
  });
});
