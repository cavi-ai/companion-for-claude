import { describe, expect, it } from "vitest";
import type { StandingOrder } from "../../src/orders/order";
import { ORDERS_OUTPUT_ROOT, orderRunPath, renderOrderRun } from "../../src/orders/output";

const order: StandingOrder = { id: "Claude/Templates/Follow ups.md", name: "Follow ups", path: "Claude/Templates/Follow ups.md", prompt: "p", enabled: true };

describe("orderRunPath", () => {
  it("is rooted under the output root with a local date and time", () => {
    expect(ORDERS_OUTPUT_ROOT).toBe("Claude/Orders");
    expect(orderRunPath(order, new Date(2026, 9, 2, 8, 5))).toBe("Claude/Orders/Follow ups/2026-10-02 0805.md");
  });

  it("strips characters that are unsafe in a folder name", () => {
    expect(orderRunPath({ ...order, name: 'a/b:c*?"<>|#^[]d' }, new Date(2026, 9, 2, 8, 5))).toBe("Claude/Orders/abcd/2026-10-02 0805.md");
    expect(orderRunPath({ ...order, name: "///" }, new Date(2026, 9, 2, 8, 5))).toBe("Claude/Orders/order/2026-10-02 0805.md");
  });
});

describe("renderOrderRun", () => {
  it("renders a schedule run with no output", () => {
    const text = renderOrderRun(order, { kind: "schedule" }, { text: "", proposals: [] });
    expect(text).toBe(['---', 'type: "order-run"', 'order: "[[Claude/Templates/Follow ups]]"', 'trigger: "schedule"', "proposed_edits: 0", "---", "", "No output.", ""].join("\n"));
  });

  it("renders a note run with the source and its proposed edits", () => {
    const text = renderOrderRun(order, { kind: "note", path: "Meetings/a.md", content: "x" }, {
      text: "Found one item.",
      proposals: [{ path: "Meetings/a.md", edits: [{ old_str: "a", new_str: "b" }], description: "Mark shipped" }, { path: "Meetings/b.md", edits: [{ old_str: "a", new_str: "b" }] }],
    });
    expect(text).toContain('trigger: "note"');
    expect(text).toContain('source: "[[Meetings/a]]"');
    expect(text).toContain("proposed_edits: 2");
    expect(text).toContain("Found one item.");
    expect(text).toContain("## Proposed edits\n\n- [[Meetings/a]] — Mark shipped\n- [[Meetings/b]]");
  });

  it("records a failed run's error text", () => {
    const text = renderOrderRun(order, { kind: "schedule" }, { text: "", proposals: [], error: new Error("rate limited") });
    expect(text).toContain("Run failed: rate limited");
    expect(text).not.toContain("No output.");
  });
});
