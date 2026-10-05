import { describe, expect, it } from "vitest";
import { normalizeOptimizeState } from "../../src/optimize/state";

describe("normalizeOptimizeState", () => {
  it("returns empty for anything that is not a dismissed list", () => {
    expect(normalizeOptimizeState(undefined)).toEqual({ dismissed: [], verdicts: {} });
    expect(normalizeOptimizeState({ dismissed: "x" })).toEqual({ dismissed: [], verdicts: {} });
  });

  it("keeps strings only, deduped", () => {
    expect(normalizeOptimizeState({ dismissed: ["a|b", 4, null, "a|b", "c|d"] })).toEqual({ dismissed: ["a|b", "c|d"], verdicts: {} });
  });

  it("keeps the newest 2000", () => {
    const list = Array.from({ length: 2005 }, (_, i) => `t${i}|u${i}`);
    const { dismissed } = normalizeOptimizeState({ dismissed: list });
    expect(dismissed).toHaveLength(2000);
    expect(dismissed[0]).toBe("t5|u5");
    expect(dismissed[1999]).toBe("t2004|u2004");
  });

  it("moves a re-dismissed id to the newest position", () => {
    expect(normalizeOptimizeState({ dismissed: ["a|b", "c|d", "a|b"] })).toEqual({ dismissed: ["c|d", "a|b"], verdicts: {} });
  });

  const v = (at: string, over: Record<string, unknown> = {}) => ({ verdict: "merge", canonical: "b", a: "a", b: "b", model: "m", at, ...over });

  it("loads state without verdicts as empty and keeps a string lastBackgroundRun only", () => {
    expect(normalizeOptimizeState({ dismissed: ["a|b"] }).verdicts).toEqual({});
    expect(normalizeOptimizeState({ lastBackgroundRun: 5 })).not.toHaveProperty("lastBackgroundRun");
    expect(normalizeOptimizeState({ lastBackgroundRun: "2026-10-05T00:00:00.000Z" }).lastBackgroundRun).toBe("2026-10-05T00:00:00.000Z");
  });

  it("drops verdict entries with a wrong shape", () => {
    const out = normalizeOptimizeState({ verdicts: { "a|b": v("t1"), bad1: v("t1", { verdict: "maybe" }), bad2: v("t1", { a: 1 }), bad3: "x", bad4: v("t1", { canonical: 3 }) } });
    expect(Object.keys(out.verdicts)).toEqual(["a|b"]);
  });

  it("drops entries whose pair does not match the key or whose merge has no canonical inside the pair", () => {
    const out = normalizeOptimizeState({
      verdicts: {
        "x|y": v("t1", { canonical: "zzz", a: "p", b: "q" }),
        "p|q": v("t1", { canonical: undefined, a: "p", b: "q" }),
        "p|r": v("t2", { canonical: "zzz", a: "p", b: "r" }),
        "a|b": v("t3"),
        "k|l": v("t4", { verdict: "keep", canonical: undefined, a: "l", b: "k" }),
      },
    });
    expect(Object.keys(out.verdicts).sort()).toEqual(["a|b", "k|l"]);
  });

  it("keeps the newest 2000 verdicts by at", () => {
    const verdicts = Object.fromEntries(Array.from({ length: 2005 }, (_, i) => [`k${i}|l${i}`, v(`2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, { a: `k${i}`, b: `l${i}`, canonical: `k${i}` })]));
    const out = normalizeOptimizeState({ verdicts }).verdicts;
    expect(Object.keys(out)).toHaveLength(2000);
    expect(out["k2004|l2004"]).toBeDefined();
    expect(out["k0|l0"]).toBeUndefined();
  });
});

describe("normalizeOptimizeState dismissedLinks", () => {
  it("omits dismissedLinks when there are none, so existing state is unchanged", () => {
    expect(normalizeOptimizeState({ dismissed: ["a|b"] })).toEqual({ dismissed: ["a|b"], verdicts: {} });
    expect(normalizeOptimizeState({ dismissedLinks: "x" })).not.toHaveProperty("dismissedLinks");
  });

  it("keeps the newest 2000 of 2,100 distinct dismissedLinks, in order", () => {
    const keys = Array.from({ length: 2100 }, (_, i) => `s${i}\u0000t${i}`);
    const out = normalizeOptimizeState({ dismissedLinks: keys });
    expect(out.dismissedLinks).toEqual(keys.slice(100));
  });

  it("keeps string pairs only, deduped, newest 2000, independent of tag dismissals", () => {
    const out = normalizeOptimizeState({ dismissed: ["t|u"], dismissedLinks: ["a.md\u0000b.md", 3, null, "a.md\u0000b.md", "c.md\u0000d.md"] });
    expect(out.dismissed).toEqual(["t|u"]);
    expect(out.dismissedLinks).toEqual(["a.md\u0000b.md", "c.md\u0000d.md"]);
    const many = normalizeOptimizeState({ dismissedLinks: Array.from({ length: 2005 }, (_, i) => `s${i}\u0000t${i}`) });
    expect(many.dismissedLinks).toHaveLength(2000);
    expect(many.dismissedLinks?.[1999]).toBe("s2004\u0000t2004");
  });

  it("keeps verdicts and lastBackgroundRun alongside dismissedLinks", () => {
    const out = normalizeOptimizeState({ dismissedLinks: ["a\u0000b"], lastBackgroundRun: "2026-10-05T00:00:00.000Z" });
    expect(out).toEqual({ dismissed: [], verdicts: {}, dismissedLinks: ["a\u0000b"], lastBackgroundRun: "2026-10-05T00:00:00.000Z" });
  });
});
