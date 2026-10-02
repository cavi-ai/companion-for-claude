import { describe, expect, it } from "vitest";
import { matchingOrders, type NoteFacts } from "../../src/orders/match";
import type { StandingOrder } from "../../src/orders/order";
import type { OrdersState } from "../../src/orders/state";

const EXCLUDED = ["Claude/Templates", "Claude/Orders"];

function order(onNote: StandingOrder["onNote"], over: Partial<StandingOrder> = {}): StandingOrder {
  return { id: "o", name: "o", path: "o.md", prompt: "p", enabled: true, ...(onNote ? { onNote } : {}), ...over };
}
const armed = (over: Partial<OrdersState["o"]> = {}): OrdersState => ({ o: { enabledAt: 100, lastRunAt: 100, fired: [], hourStart: 0, hourCount: 0, ...over } });
const note = (over: Partial<NoteFacts> = {}): NoteFacts => ({ path: "Meetings/a.md", ctime: 200, tags: [], ...over });
const match = (o: StandingOrder, n: NoteFacts, state = armed()) => matchingOrders([o], n, state, EXCLUDED);

describe("matchingOrders", () => {
  it("matches a note under the folder, including subfolders", () => {
    expect(match(order({ folder: "Meetings" }), note())).toEqual(["o"]);
    expect(match(order({ folder: "Meetings" }), note({ path: "Meetings/2026/b.md" }))).toEqual(["o"]);
  });

  it("does not match a sibling folder sharing the prefix", () => {
    expect(match(order({ folder: "Meetings" }), note({ path: "Meetingsx/a.md" }))).toEqual([]);
  });

  it("matches on tag", () => {
    expect(match(order({ tag: "meeting" }), note({ tags: ["meeting"] }))).toEqual(["o"]);
    expect(match(order({ tag: "meeting" }), note({ tags: ["other"] }))).toEqual([]);
  });

  it("needs every given key", () => {
    const both = order({ folder: "Meetings", tag: "meeting" });
    expect(match(both, note({ tags: ["meeting"] }))).toEqual(["o"]);
    expect(match(both, note({ tags: [] }))).toEqual([]);
    expect(match(both, note({ path: "Other/a.md", tags: ["meeting"] }))).toEqual([]);
  });

  it("skips notes that existed when the order was enabled", () => {
    expect(match(order({ folder: "Meetings" }), note({ ctime: 100 }))).toEqual([]);
    expect(match(order({ folder: "Meetings" }), note({ ctime: 50 }))).toEqual([]);
  });

  it("skips a path the order already fired for", () => {
    expect(match(order({ folder: "Meetings" }), note(), armed({ fired: ["Meetings/a.md"] }))).toEqual([]);
  });

  it("never matches the output root, even for an order with only a tag the output carries", () => {
    const tagOnly = order({ tag: "order-run" });
    expect(match(tagOnly, note({ path: "Claude/Orders/X/run.md", tags: ["order-run"] }))).toEqual([]);
    expect(match(order({ folder: "Claude" }), note({ path: "Claude/Orders/X/run.md" }))).toEqual([]);
  });

  it("never matches the templates folder", () => {
    expect(match(order({ tag: "meeting" }), note({ path: "Claude/Templates/t.md", tags: ["meeting"] }))).toEqual([]);
  });

  it("ignores disabled, unarmed and schedule-only orders", () => {
    expect(match(order({ folder: "Meetings" }, { enabled: false }), note())).toEqual([]);
    expect(match(order({ folder: "Meetings" }), note(), {})).toEqual([]);
    expect(match(order(undefined), note())).toEqual([]);
  });
});
