import { describe, expect, it } from "vitest";
import type { StandingOrder } from "../../src/orders/order";
import { dueOrders, lastSlot } from "../../src/orders/schedule";
import type { OrdersState } from "../../src/orders/state";

function order(over: Partial<StandingOrder>): StandingOrder {
  return { id: "o", name: "o", path: "o.md", prompt: "p", enabled: true, ...over };
}
const stateAt = (lastRunAt: number): OrdersState => ({ o: { enabledAt: 0, lastRunAt, fired: [], hourStart: 0, hourCount: 0 } });
const daily = order({ schedule: { kind: "daily", hour: 8, minute: 0 } });

describe("lastSlot", () => {
  it("is today's slot once it has passed", () => {
    expect(lastSlot({ kind: "daily", hour: 8, minute: 0 }, new Date(2026, 9, 7, 9, 30))).toBe(new Date(2026, 9, 7, 8, 0).getTime());
  });

  it("is yesterday's slot before today's", () => {
    expect(lastSlot({ kind: "daily", hour: 8, minute: 0 }, new Date(2026, 9, 7, 7, 59))).toBe(new Date(2026, 9, 6, 8, 0).getTime());
  });

  it("is the previous Monday for a weekly Monday slot on a Wednesday", () => {
    expect(lastSlot({ kind: "weekly", day: "mon", hour: 8, minute: 0 }, new Date(2026, 9, 7, 12, 0))).toBe(new Date(2026, 9, 5, 8, 0).getTime());
  });

  it("goes back a full week on the slot's weekday before the slot time", () => {
    expect(lastSlot({ kind: "weekly", day: "mon", hour: 8, minute: 0 }, new Date(2026, 9, 5, 7, 0))).toBe(new Date(2026, 9, 5 - 7, 8, 0).getTime());
  });
});

describe("dueOrders", () => {
  const now = new Date(2026, 9, 7, 8, 1);
  const slot = new Date(2026, 9, 7, 8, 0).getTime();

  it("is due right after a slot the order has not run for", () => {
    expect(dueOrders([daily], stateAt(slot - 60_000), now)).toEqual(["o"]);
  });

  it("is not due again once it ran in that slot", () => {
    expect(dueOrders([daily], stateAt(slot), now)).toEqual([]);
  });

  it("returns one id after a week of missed daily slots", () => {
    expect(dueOrders([daily], stateAt(now.getTime() - 7 * 86_400_000), now)).toEqual(["o"]);
  });

  it("is not due without state or when disabled or unscheduled", () => {
    expect(dueOrders([daily], {}, now)).toEqual([]);
    expect(dueOrders([{ ...daily, enabled: false }], stateAt(0), now)).toEqual([]);
    expect(dueOrders([order({ onNote: { folder: "A" } })], stateAt(0), now)).toEqual([]);
  });
});
