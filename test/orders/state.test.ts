import { describe, expect, it } from "vitest";
import type { StandingOrder } from "../../src/orders/order";
import {
  armOrders,
  normalizeOrdersState,
  ORDER_FIRED_CAP,
  ORDER_NOTE_RUNS_PER_HOUR,
  recordFired,
  recordRun,
  takeHourSlot,
  type OrdersState,
} from "../../src/orders/state";

function order(id: string, enabled: boolean): StandingOrder {
  return { id, name: id, path: id, prompt: "p", enabled, onNote: { folder: "A" } };
}

const entry = { enabledAt: 1, lastRunAt: 1, fired: [], hourStart: 0, hourCount: 0 };

describe("armOrders", () => {
  it("arms enabled orders at now and leaves existing state alone", () => {
    const state: OrdersState = { a: { ...entry, enabledAt: 5, lastRunAt: 9 } };
    const next = armOrders(state, [order("a", true), order("b", true)], 100);
    expect(next.a).toEqual(state.a);
    expect(next.b).toEqual({ enabledAt: 100, lastRunAt: 100, fired: [], hourStart: 0, hourCount: 0 });
  });

  it("drops state for disabled or missing orders and re-arms on re-enable", () => {
    const state: OrdersState = { a: { ...entry }, gone: { ...entry } };
    const dropped = armOrders(state, [order("a", false)], 100);
    expect(dropped).toEqual({});
    expect(armOrders(dropped, [order("a", true)], 200).a?.enabledAt).toBe(200);
  });

  it("does not mutate its input", () => {
    const state: OrdersState = { a: { ...entry } };
    const snapshot = JSON.stringify(state);
    armOrders(state, [order("b", true)], 5);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("recordFired and recordRun", () => {
  it("keeps the newest 500 fired paths", () => {
    let state: OrdersState = { a: { ...entry } };
    for (let i = 0; i < ORDER_FIRED_CAP + 3; i++) state = recordFired(state, "a", `n${i}.md`);
    expect(state.a?.fired).toHaveLength(ORDER_FIRED_CAP);
    expect(state.a?.fired[0]).toBe("n3.md");
    expect(state.a?.fired.at(-1)).toBe(`n${ORDER_FIRED_CAP + 2}.md`);
  });

  it("does not record a path twice", () => {
    const once = recordFired({ a: { ...entry } }, "a", "x.md");
    expect(recordFired(once, "a", "x.md").a?.fired).toEqual(["x.md"]);
  });

  it("stamps the last run and ignores unknown ids", () => {
    expect(recordRun({ a: { ...entry } }, "a", 42).a?.lastRunAt).toBe(42);
    expect(recordRun({}, "a", 42)).toEqual({});
    expect(recordFired({}, "a", "x.md")).toEqual({});
  });
});

describe("takeHourSlot", () => {
  const HOUR = 3_600_000;

  it("allows the hourly cap then refuses, and allows again next clock hour", () => {
    let state: OrdersState = { a: { ...entry } };
    const base = 10 * HOUR + 5;
    for (let i = 0; i < ORDER_NOTE_RUNS_PER_HOUR; i++) {
      const taken = takeHourSlot(state, "a", base + i);
      expect(taken.allowed).toBe(true);
      state = taken.state;
    }
    const refused = takeHourSlot(state, "a", base + 100);
    expect(refused.allowed).toBe(false);
    expect(takeHourSlot(refused.state, "a", 11 * HOUR + 1).allowed).toBe(true);
  });

  it("refuses an unknown order", () => {
    expect(takeHourSlot({}, "a", 5).allowed).toBe(false);
  });
});

describe("normalizeOrdersState", () => {
  it("drops malformed entries and keeps valid ones", () => {
    const raw = {
      ok: { enabledAt: 1, lastRunAt: 2, fired: ["a.md", 3], hourStart: 4, hourCount: 5 },
      noNumbers: { enabledAt: "x", lastRunAt: 2, fired: [], hourStart: 0, hourCount: 0 },
      notObject: 7,
      nullEntry: null,
    };
    expect(normalizeOrdersState(raw)).toEqual({ ok: { enabledAt: 1, lastRunAt: 2, fired: ["a.md"], hourStart: 4, hourCount: 5 } });
  });

  it("returns an empty state for non-objects", () => {
    expect(normalizeOrdersState(undefined)).toEqual({});
    expect(normalizeOrdersState([1])).toEqual({});
    expect(normalizeOrdersState("x")).toEqual({});
  });
});
