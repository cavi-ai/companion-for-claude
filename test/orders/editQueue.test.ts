import { describe, expect, it } from "vitest";
import { enqueueEdit, normalizeEditQueue, removeEdit, replaceEdits, type QueuedEdit } from "../../src/orders/editQueue";

function item(id: string, over: Partial<QueuedEdit> = {}): QueuedEdit {
  return { id, orderId: "o.md", orderName: "o", runPath: "Claude/Orders/o/r.md", path: "A.md", edits: [{ old_str: "a", new_str: "b" }], createdAt: 1, ...over };
}

describe("edit queue", () => {
  it("adds and removes without mutating", () => {
    const empty: QueuedEdit[] = [];
    const one = enqueueEdit(empty, item("1"));
    expect(empty).toEqual([]);
    expect(enqueueEdit(one, item("2")).map((q) => q.id)).toEqual(["1", "2"]);
    expect(removeEdit(one, "1")).toEqual([]);
    expect(removeEdit(one, "missing")).toEqual(one);
  });

  it("replaces the edits of an item and removes it when none remain", () => {
    const queue = [item("1"), item("2")];
    const next = replaceEdits(queue, "1", [{ old_str: "x", new_str: "y" }]);
    expect(next[0]?.edits).toEqual([{ old_str: "x", new_str: "y" }]);
    expect(next[1]).toEqual(queue[1]);
    expect(replaceEdits(queue, "1", []).map((q) => q.id)).toEqual(["2"]);
  });

  it("does not queue the same id twice", () => {
    expect(enqueueEdit([item("1")], item("1")).map((q) => q.id)).toEqual(["1"]);
  });

  it("normalize keeps well-formed items and drops malformed ones", () => {
    const good = item("1", { description: "Mark shipped" });
    const raw = [
      good,
      { ...item("2"), edits: [] },
      { ...item("3"), edits: [{ old_str: 1, new_str: "b" }] },
      { ...item("4"), createdAt: "x" },
      null,
      "x",
    ];
    expect(normalizeEditQueue(raw)).toEqual([good]);
    expect(normalizeEditQueue(undefined)).toEqual([]);
    expect(normalizeEditQueue({})).toEqual([]);
  });
});
