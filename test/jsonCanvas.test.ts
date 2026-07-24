import { describe, it, expect } from "vitest";
import { buildCanvas, serializeCanvas } from "../src/canvas/jsonCanvas";

describe("buildCanvas", () => {
  it("normalizes nodes with generated ids, inferred types, and defaults", () => {
    const c = buildCanvas(
      [{ text: "Root idea" }, { file: "Projects/Foo.md" }, { url: "https://example.com" }],
      [],
    );
    expect(c.nodes.map((n) => n.id)).toEqual(["node-1", "node-2", "node-3"]);
    expect(c.nodes.map((n) => n.type)).toEqual(["text", "file", "link"]);
    expect(c.nodes[0]).toMatchObject({ text: "Root idea", width: 380, height: 180 });
    expect(c.nodes[1]).toMatchObject({ file: "Projects/Foo.md" });
  });

  it("lays out unplaced nodes in layers by edge depth", () => {
    const c = buildCanvas(
      [
        { id: "a", text: "root" },
        { id: "b", text: "child" },
        { id: "c", text: "grandchild" },
        { id: "d", text: "second child" },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "d" },
      ],
    );
    const byId = new Map(c.nodes.map((n) => [n.id, n]));
    expect(byId.get("a")!.x).toBe(0);
    expect(byId.get("b")!.x).toBe(480);
    expect(byId.get("c")!.x).toBe(960);
    expect(byId.get("d")!.x).toBe(480);
    expect(byId.get("b")!.y).not.toBe(byId.get("d")!.y); // same column, different rows
  });

  it("respects explicit coordinates and survives cycles", () => {
    const c = buildCanvas(
      [
        { id: "a", text: "pinned", x: 42, y: 24 },
        { id: "b", text: "loop" },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" }, // cycle
      ],
    );
    expect(c.nodes.find((n) => n.id === "a")).toMatchObject({ x: 42, y: 24 });
    expect(Number.isNaN(c.nodes.find((n) => n.id === "b")!.x)).toBe(false);
  });

  it("normalizes edges with sides and labels", () => {
    const c = buildCanvas([{ id: "a", text: "x" }, { id: "b", text: "y" }], [{ from: "a", to: "b", label: "leads to" }]);
    expect(c.edges[0]).toEqual({ id: "edge-1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", label: "leads to" });
  });

  it("wraps grouped members in an auto-sized group box", () => {
    const c = buildCanvas(
      [
        { id: "g", type: "group", label: "Cluster" },
        { id: "a", text: "one", group: "g" },
        { id: "b", text: "two", group: "g" },
        { id: "c", text: "three", group: "g" },
        { id: "solo", text: "outside" },
      ],
      [],
    );
    const byId = new Map(c.nodes.map((n) => [n.id, n]));
    const g = byId.get("g")!;
    expect(g).toMatchObject({ type: "group", label: "Cluster" });
    for (const id of ["a", "b", "c"]) {
      const m = byId.get(id)!;
      expect(m.x).toBeGreaterThanOrEqual(g.x);
      expect(m.y).toBeGreaterThanOrEqual(g.y);
      expect(m.x + m.width).toBeLessThanOrEqual(g.x + g.width);
      expect(m.y + m.height).toBeLessThanOrEqual(g.y + g.height);
    }
    // the ungrouped node stays outside the group box
    const solo = byId.get("solo")!;
    expect(
      solo.x + solo.width <= g.x || solo.x >= g.x + g.width ||
      solo.y + solo.height <= g.y || solo.y >= g.y + g.height,
    ).toBe(true);
  });

  it("respects explicit group geometry and places unplaced members inside it", () => {
    const c = buildCanvas(
      [
        { id: "g", type: "group", label: "Fixed", x: 1000, y: 1000, width: 900, height: 700 },
        { id: "a", text: "kid", group: "g" },
      ],
      [],
    );
    const byId = new Map(c.nodes.map((n) => [n.id, n]));
    expect(byId.get("g")).toMatchObject({ x: 1000, y: 1000, width: 900, height: 700 });
    const a = byId.get("a")!;
    expect(a.x).toBeGreaterThanOrEqual(1000);
    expect(a.y).toBeGreaterThanOrEqual(1000);
  });

  it("validates group membership", () => {
    expect(() => buildCanvas([{ id: "a", text: "x", group: "ghost" }], [])).toThrow(/unknown group/i);
    expect(() => buildCanvas(
      [{ id: "n", text: "not a group" }, { id: "a", text: "x", group: "n" }],
      [],
    )).toThrow(/not a group/i);
    expect(() => buildCanvas(
      [{ id: "g1", type: "group" }, { id: "g2", type: "group", group: "g1" }],
      [],
    )).toThrow(/nested/i);
  });

  it("allows edges attached to groups", () => {
    const c = buildCanvas(
      [{ id: "g", type: "group", label: "G" }, { id: "a", text: "x" }],
      [{ from: "a", to: "g" }],
    );
    expect(c.edges[0]).toMatchObject({ fromNode: "a", toNode: "g" });
  });

  it("rejects invalid proposals with actionable messages", () => {
    expect(() => buildCanvas([], [])).toThrow(/at least one node/i);
    expect(() => buildCanvas([{ id: "a", text: "x" }, { id: "a", text: "y" }], [])).toThrow(/duplicate/i);
    expect(() => buildCanvas([{ id: "a" }], [])).toThrow(/text/i);
    expect(() => buildCanvas([{ id: "a", text: "x" }], [{ from: "a", to: "ghost" }])).toThrow(/unknown node/i);
    const many = Array.from({ length: 61 }, (_, i) => ({ text: `n${i}` }));
    expect(() => buildCanvas(many, [])).toThrow(/too many/i);
  });
});

describe("serializeCanvas", () => {
  it("round-trips as valid JSON Canvas", () => {
    const c = buildCanvas([{ id: "a", text: "hello" }], []);
    const parsed = JSON.parse(serializeCanvas(c)) as { nodes: unknown[]; edges: unknown[] };
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.edges).toEqual([]);
  });
});
