import { describe, expect, it } from "vitest";
import { planEdits } from "../../src/edit/diff";
import {
  createRangeSession,
  createSession,
  decisions,
  mapSession,
  markHunk,
  pendingHunks,
  planResolve,
} from "../../src/editor/inlineDiffState";

const DOC = "# Build plan\n\n- [ ] Create the parser\n- [ ] Wire the interface\n- [ ] Ship it\n";
const META = { path: "Build plan.md", description: "Rename steps" };

const twoHunkSession = () =>
  createSession(
    DOC,
    planEdits(DOC, [
      { old_str: "Create the parser", new_str: "Create the tokenizer" },
      { old_str: "Ship it", new_str: "Ship it to the store" },
    ]),
    META,
  );

describe("createSession", () => {
  it("anchors every hunk at its whole-line region in document offsets", () => {
    const s = twoHunkSession();
    expect(s.path).toBe("Build plan.md");
    expect(s.description).toBe("Rename steps");
    expect(s.hunks).toHaveLength(2);
    const [a, b] = s.hunks;
    expect(DOC.slice(a!.from, a!.to)).toBe("- [ ] Create the parser");
    expect(a!.newText).toBe("- [ ] Create the tokenizer");
    expect(DOC.slice(b!.from, b!.to)).toBe("- [ ] Ship it");
    expect(s.hunks.every((h) => h.status === "pending")).toBe(true);
    expect(a!.index).toBe(0);
    expect(b!.index).toBe(1);
  });

  it("omits description when none is given", () => {
    const s = createSession(DOC, planEdits(DOC, [{ old_str: "Ship it", new_str: "Ship" }]), { path: "x.md" });
    expect("description" in s).toBe(false);
  });

  it("throws when the document drifted from the plan", () => {
    const plan = planEdits(DOC, [{ old_str: "Ship it", new_str: "Ship" }]);
    expect(() => createSession(DOC.replace("Ship it", "Sail it"), plan, META)).toThrow(/changed/);
  });
});

describe("createRangeSession", () => {
  it("wraps an editor selection as one pending hunk", () => {
    const from = DOC.indexOf("Wire");
    const to = from + "Wire the interface".length;
    const s = createRangeSession(DOC, { from, to, newText: "Wire it up" }, { path: "Build plan.md" });
    expect(s.hunks).toEqual([{ index: 0, from, to, oldText: "Wire the interface", newText: "Wire it up", status: "pending" }]);
  });

  it("refuses an empty range", () => {
    expect(() => createRangeSession(DOC, { from: 3, to: 3, newText: "x" }, { path: "a.md" })).toThrow(/Nothing selected/);
  });
});

describe("planResolve", () => {
  it("accepting yields the replacement change", () => {
    const s = twoHunkSession();
    const h = s.hunks[0]!;
    expect(planResolve(s, 0, "accepted", DOC)).toEqual({ change: { from: h.from, to: h.to, insert: h.newText }, drifted: false });
  });

  it("rejecting yields no change", () => {
    expect(planResolve(twoHunkSession(), 1, "rejected", DOC)).toEqual({ change: null, drifted: false });
  });

  it("reports drift instead of replacing text that moved under the hunk", () => {
    const s = twoHunkSession();
    expect(planResolve(s, 0, "accepted", DOC.replace("Create the parser", "Create the PARSER"))).toEqual({ change: null, drifted: true });
  });

  it("is a no-op for a resolved or unknown hunk", () => {
    const s = markHunk(twoHunkSession(), 0, "accepted");
    expect(planResolve(s, 0, "accepted", DOC)).toEqual({ change: null, drifted: false });
    expect(planResolve(s, 9, "accepted", DOC)).toEqual({ change: null, drifted: false });
  });
});

describe("markHunk / pendingHunks / decisions", () => {
  it("marks one hunk without touching the others", () => {
    const s = markHunk(twoHunkSession(), 1, "rejected");
    expect(s.hunks.map((h) => h.status)).toEqual(["pending", "rejected"]);
    expect(pendingHunks(s).map((h) => h.index)).toEqual([0]);
  });

  it("reports accepted flags in hunk order, pending counting as false", () => {
    const s = markHunk(twoHunkSession(), 1, "accepted");
    expect(decisions(s)).toEqual([false, true]);
  });
});

describe("mapSession", () => {
  it("shifts anchors after an insertion earlier in the document", () => {
    const s = twoHunkSession();
    const inserted = 7;
    const cut = s.hunks[0]!.to;
    const mapped = mapSession(s, (pos) => (pos > cut ? pos + inserted : pos));
    expect(mapped.hunks[0]!.from).toBe(s.hunks[0]!.from);
    expect(mapped.hunks[1]!.from).toBe(s.hunks[1]!.from + inserted);
    expect(mapped.hunks[1]!.to).toBe(s.hunks[1]!.to + inserted);
  });

  it("asks for assoc 1 on from and -1 on to", () => {
    const seen: Array<[number, -1 | 1]> = [];
    mapSession(twoHunkSession(), (pos, assoc) => {
      seen.push([pos, assoc]);
      return pos;
    });
    expect(seen.map(([, a]) => a)).toEqual([1, -1, 1, -1]);
  });
});
