import { describe, expect, it, vi } from "vitest";
import { formatApplyNotice, type ApplyResult, OptimizeController, type OptimizeDeps } from "../../src/optimize/controller";
import { tagId } from "../../src/tags/vocabulary";
import { pairKey } from "../../src/optimize/tagScan";
import type { NoteTagInput } from "../../src/optimize/mergePlan";
import type { OptimizeState } from "../../src/optimize/state";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import { VerdictParseError, type Verdict } from "../../src/optimize/classify";
import { ClassifierStoppedError } from "../../src/optimize/classifierGlue";
import type { MergeCandidate } from "../../src/optimize/tagScan";

function setup(over: Partial<OptimizeDeps> = {}, notes: Record<string, { fm: string[]; inline?: Array<{ tag: string; start: number; end: number }> }> = {}) {
  let state: OptimizeState = { dismissed: [], verdicts: {} };
  const rewritten: string[] = [];
  const writes: Array<{ content: string; now: string }> = [];
  const entries = Object.entries(notes).map(([path, n]) => ({ path, tags: [...n.fm, ...(n.inline ?? []).map((i) => i.tag)] }));
  const deps: OptimizeDeps = {
    tagEntries: () => entries,
    noteVectors: async () => null,
    noteTags: (path): NoteTagInput | null => {
      const n = notes[path];
      return n ? { path, frontmatterTags: n.fm, inline: n.inline ?? [] } : null;
    },
    rewriteNote: async (plan, map) => {
      rewritten.push(plan.path);
      const changed = new Set(plan.inline.map((e) => e.from));
      for (const t of plan.before) if (map.has(tagId(t))) changed.add(tagId(t));
      return { inlineApplied: plan.inline.length, inlineSkipped: 0, changed: [...changed] };
    },
    orderTagTriggers: () => [],
    writeRunNote: async (content, now) => {
      writes.push({ content, now });
      return "Claude/Optimize/run.md";
    },
    getState: () => state,
    setState: async (next) => {
      state = next;
    },
    now: () => "2026-10-05T10:00:00.000Z",
    classifier: async () => { throw new UtilityUnavailableError("off", { state: "unavailable-without-Claude", backend: "ollama", endpoint: "", reason: "claude-unavailable" }); },
    ...over,
  };
  return { controller: new OptimizeController(deps), rewritten, writes, getState: () => state };
}

const NOTES = {
  "a.md": { fm: ["llms", "llm"] },
  "b.md": { fm: ["llm"] },
  "c.md": { fm: ["x"], inline: [{ tag: "llms", start: 0, end: 5 }] },
};

describe("OptimizeController.scan", () => {
  it("returns name-based candidates when the index is missing, empty, or throws, and never errors", async () => {
    for (const noteVectors of [async () => null, async () => () => null, async () => { throw new Error("boom"); }]) {
      const { controller } = setup({ noteVectors }, NOTES);
      const report = await controller.scan();
      expect(report.candidates.map((c) => c.id)).toEqual([pairKey("llm", "llms")]);
    }
  });

  it("skips noteVectors when semantic is false", async () => {
    const noteVectors = vi.fn(async () => null);
    const { controller } = setup({ noteVectors }, NOTES);
    await controller.scan({ semantic: false });
    expect(noteVectors).not.toHaveBeenCalled();
  });

  it("adds semantic candidates from note vectors only when semantic is on", async () => {
    const vecs: Record<string, number[]> = { "a.md": [1, 0], "b.md": [1, 0.01], "c.md": [1, 0.02], "d.md": [1, 0.015] };
    const notes = { "a.md": { fm: ["machine-learning"] }, "b.md": { fm: ["machine-learning"] }, "c.md": { fm: ["machine-learning"] }, "d.md": { fm: ["ml"] } };
    const { controller } = setup({ noteVectors: async () => (p) => vecs[p] ?? null }, notes);
    const on = await controller.scan();
    expect(on.candidates).toMatchObject([{ from: "ml", to: "machine-learning", evidence: ["semantic"] }]);
    expect((await controller.scan({ semantic: false })).candidates).toEqual([]);
  });

  it("honors persisted dismissals", async () => {
    const { controller } = setup({}, NOTES);
    await controller.dismiss(pairKey("llm", "llms"));
    expect((await controller.scan()).candidates).toEqual([]);
  });
});

describe("OptimizeController tag identity", () => {
  const many = (tag: string, n: number, prefix: string) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.md`, { fm: [tag] }]));

  it("pairs emoji tags by their own spelling", async () => {
    const { controller } = setup({}, { ...many("📚book", 4, "b"), ...many("📚books", 1, "s") });
    const report = await controller.scan();
    expect(report.candidates).toMatchObject([{ from: "📚books", to: "📚book", evidence: ["plural"] }]);
  });

  it("does not pair unrelated non-latin tags", async () => {
    const { controller } = setup({}, { ...many("हिंदी", 3, "h"), ...many("हद", 1, "d") });
    expect((await controller.scan()).candidates).toEqual([]);
  });

  it("keeps a numeric-looking tag's own spelling", async () => {
    const { controller } = setup({}, { ...many("2024-01", 3, "h"), ...many("2024_01", 1, "d") });
    expect((await controller.scan()).candidates).toMatchObject([{ from: "2024_01", to: "2024-01" }]);
  });

  it("every candidate side is the tagId of some entry tag", async () => {
    const notes = { ...many("📚book", 4, "b"), ...many("#LLMs", 1, "l"), ...many("llm", 3, "m"), ...many("2024_01", 1, "d"), ...many("2024-01", 3, "e") };
    const { controller } = setup({}, notes);
    const ids = new Set(["📚book", "llms", "llm", "2024_01", "2024-01"]);
    const report = await controller.scan();
    expect(report.candidates.length).toBeGreaterThan(0);
    for (const c of report.candidates) {
      expect(ids.has(c.from)).toBe(true);
      expect(ids.has(c.to)).toBe(true);
    }
  });

  it("plans the written spelling for a merge selected from the scan", async () => {
    const plans: string[][] = [];
    const { controller } = setup(
      {
        noteTags: (path) => ({ path, frontmatterTags: ["📚books"], inline: [] }),
        rewriteNote: async (plan) => {
          plans.push(plan.after);
          return { inlineApplied: 0, inlineSkipped: 0, changed: ["📚books"] };
        },
      },
      { "s0.md": { fm: ["📚books"] } },
    );
    await controller.apply([{ from: "📚books", to: "📚book" }]);
    expect(plans).toEqual([["📚book"]]);
  });
});

describe("OptimizeController.apply", () => {
  it("rewrites the union of the from-tags' notes, writes one run note, reports counts", async () => {
    const { controller, rewritten, writes } = setup({}, NOTES);
    const result = await controller.apply([{ from: "llms", to: "llm" }]);
    expect(rewritten.sort()).toEqual(["a.md", "c.md"]);
    expect(result).toMatchObject({ merges: 1, notes: 2, inlineSkipped: 0, failed: [], unchanged: 0, dropped: [], orders: [], runNote: "Claude/Optimize/run.md" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.now).toBe("2026-10-05T10:00:00.000Z");
    expect(writes[0]?.content).toContain("`llms` → `llm`");
  });

  it("sums skipped inline occurrences", async () => {
    const { controller } = setup({ rewriteNote: async () => ({ inlineApplied: 0, inlineSkipped: 2, changed: ["llms"] }) }, NOTES);
    expect((await controller.apply([{ from: "llms", to: "llm" }])).inlineSkipped).toBe(4);
  });

  it("writes no run note and touches nothing when no note changes", async () => {
    const { controller, rewritten, writes } = setup({}, NOTES);
    const result = await controller.apply([{ from: "nothing", to: "llm" }]);
    expect(result).toMatchObject({ merges: 0, notes: 0, runNote: null });
    expect(rewritten).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("collapses a chain and reports a cycle without applying it", async () => {
    const { controller, rewritten } = setup({}, { "a.md": { fm: ["a"] }, "b.md": { fm: ["x"] }, "c.md": { fm: ["y"] } });
    const result = await controller.apply([
      { from: "a", to: "b" }, { from: "b", to: "c" },
      { from: "x", to: "y" }, { from: "y", to: "x" },
    ]);
    expect(result.dropped.sort()).toEqual(["x", "y"]);
    expect(rewritten).toEqual(["a.md"]);
  });
});

describe("OptimizeController.apply results", () => {
  const empty = async () => ({ inlineApplied: 0, inlineSkipped: 0, changed: [] as string[] });
  const inlineNotes = {
    "a.md": { fm: ["x"], inline: [{ tag: "llms", start: 0, end: 5 }] },
    "b.md": { fm: ["x"], inline: [{ tag: "llms", start: 0, end: 5 }] },
  };

  it("counts only what was really written", async () => {
    const { controller, writes } = setup({ rewriteNote: empty }, inlineNotes);
    const result = await controller.apply([{ from: "llms", to: "llm" }]);
    expect(result).toMatchObject({ merges: 0, notes: 0, unchanged: 2, runNote: null });
    expect(writes).toEqual([]);
  });

  it("keeps going when one note throws and lists it without a wikilink", async () => {
    const notes = { "a.md": { fm: ["llms"] }, "b.md": { fm: ["llms"] }, "c.md": { fm: ["llms"] } };
    const done: string[] = [];
    const { controller, writes } = setup({
      rewriteNote: async (plan) => {
        if (plan.path === "b.md") throw new Error("locked");
        done.push(plan.path);
        return { inlineApplied: 0, inlineSkipped: 0, changed: ["llms"] };
      },
    }, notes);
    const result = await controller.apply([{ from: "llms", to: "llm" }]);
    expect(done.sort()).toEqual(["a.md", "c.md"]);
    expect(result).toMatchObject({ notes: 2, failed: ["b.md"] });
    const note = writes[0]?.content ?? "";
    expect(note).toContain("## Not rewritten");
    expect(note).toContain("`b.md`");
    expect(note).not.toContain("[[b");
  });

  it("lists a note whose tags cannot be read as failed", async () => {
    const { controller } = setup({ noteTags: () => null }, NOTES);
    expect((await controller.apply([{ from: "llms", to: "llm" }])).failed.sort()).toEqual(["a.md", "c.md"]);
  });

  it("resolves with runNote null when the run note write throws", async () => {
    const { controller } = setup({ writeRunNote: async () => { throw new Error("disk"); } }, NOTES);
    const result = await controller.apply([{ from: "llms", to: "llm" }]);
    expect(result).toMatchObject({ notes: 2, runNote: null });
  });

  it("reports every dropped merge and names it in the notice", async () => {
    const { controller } = setup({}, { "a.md": { fm: ["a"] } });
    const result = await controller.apply([
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "x", to: "a" },
    ]);
    expect([...result.dropped].sort()).toEqual(["a", "b", "c", "x"]);
    expect(formatApplyNotice(result)).toContain("4 merges dropped (cycle: ");
  });

  it("reports standing orders that trigger on a merged tag", async () => {
    const { controller, writes } = setup({
      orderTagTriggers: () => [{ path: "Claude/Templates/Meet.md", tag: "meetings" }, { path: "Claude/Templates/Other.md", tag: "other" }],
    }, { "a.md": { fm: ["meetings"] } });
    const result = await controller.apply([{ from: "meetings", to: "meeting" }]);
    expect(result.orders).toEqual(["Claude/Templates/Meet.md"]);
    expect(writes[0]?.content).toContain("## Standing orders that trigger on a merged tag");
    expect(writes[0]?.content).toContain("[[Claude/Templates/Meet]] — `meetings`");
    expect(formatApplyNotice(result)).toContain("1 standing order triggers on a merged tag");
  });
});

describe("OptimizeController.dismiss", () => {
  it("writes only plugin state, never a note", async () => {
    const { controller, rewritten, writes, getState } = setup({}, NOTES);
    await controller.dismiss("a|b");
    await controller.dismiss("a|b");
    expect(getState().dismissed).toEqual(["a|b"]);
    expect(rewritten).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("scan alone writes nothing", async () => {
    const { controller, rewritten, writes } = setup({}, NOTES);
    await controller.scan();
    expect(rewritten).toEqual([]);
    expect(writes).toEqual([]);
  });

describe("formatApplyNotice", () => {
  it("adds the skipped inline count only when there is one", () => {
    const r: ApplyResult = { merges: 3, notes: 7, inlineSkipped: 0, failed: [], unchanged: 0, dropped: [], orders: [], runNote: null };
    expect(formatApplyNotice(r)).toBe("Merged 3 tags across 7 notes");
    expect(formatApplyNotice({ ...r, inlineSkipped: 2 })).toBe("Merged 3 tags across 7 notes, 2 inline tags skipped");
    expect(formatApplyNotice({ ...r, merges: 1, notes: 1, inlineSkipped: 1, failed: ["a"], unchanged: 1, dropped: ["a"], orders: ["o"] })).toBe(
      "Merged 1 tag across 1 note, 1 inline tag skipped, 1 note failed, 1 note left unchanged, 1 merge dropped (cycle: a), 1 standing order triggers on a merged tag",
    );
    expect(formatApplyNotice({ ...r, merges: 2, notes: 2, inlineSkipped: 2, failed: ["a", "b"], unchanged: 2, dropped: ["a", "b"], orders: ["o", "p"] })).toBe(
      "Merged 2 tags across 2 notes, 2 inline tags skipped, 2 notes failed, 2 notes left unchanged, 2 merges dropped (cycle: a, b), 2 standing orders trigger on a merged tag",
    );
    expect(formatApplyNotice({ ...r, merges: 0, notes: 0 })).toBe("Merged 0 tags across 0 notes");
  });
});
});

type Classifier = Awaited<ReturnType<OptimizeDeps["classifier"]>>;
const fakeClassifier = (
  complete: Classifier["complete"],
  over: Partial<Classifier> = {},
): OptimizeDeps["classifier"] => async () => ({ local: true, label: "Ollama", model: "m1", complete, ...over });

const cand = (i: number, evidence: MergeCandidate["evidence"] = ["semantic"]): MergeCandidate => ({
  id: `a${i}|b${i}`, from: `a${i}`, to: `b${i}`, evidence, score: 0.9, fromCount: 1, toCount: 2,
});
const CLASSIFY_NOTES = {
  "x/One.md": { fm: ["ml", "machine-learning"] },
  "y/Two.md": { fm: ["ml"] },
  "z/Three.md": { fm: ["machine-learning"] },
};

describe("OptimizeController.classify", () => {
  it("sends only uncertain candidates (no separator/plural evidence, no stored verdict) with titles", async () => {
    const seen: string[] = [];
    const { controller } = setup({
      classifier: fakeClassifier(async (req) => { seen.push(req.user); return []; }),
    }, {});
    vi.spyOn(controller, "scan").mockResolvedValue({
      totalTags: 4, singleUse: 0, dropped: 0,
      candidates: [cand(1, ["separator"]), cand(2, ["plural"]), { ...cand(3), verdict: { verdict: "keep", a: "a3", b: "b3", model: "m", at: "t" } }, cand(4)],
    });
    const res = await controller.classify();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("a4");
    expect(seen[0]).not.toMatch(/a1|a2|a3/);
    expect(res.judged).toBe(0);
  });

  it("includes up to 3 note basenames per tag", async () => {
    let user = "";
    const notes = Object.fromEntries(["A", "B", "C", "D"].map((n) => [`f/${n}.md`, { fm: ["ml", "machine-learning"] }]));
    const { controller } = setup({ classifier: fakeClassifier(async (req) => { user = req.user; return []; }) }, notes);
    vi.spyOn(controller, "scan").mockResolvedValue({ totalTags: 2, singleUse: 0, dropped: 0, candidates: [{ ...cand(1), id: "ml|machine-learning", from: "ml", to: "machine-learning" }] });
    await controller.classify();
    expect(user).toContain('"A"');
    expect(user).toContain('"C"');
    expect(user).not.toContain('"D"');
    expect(user).not.toContain("f/");
  });

  it("caps at 10 calls of 20: 450 pending -> 200 judged, 250 dropped", async () => {
    const calls: number[] = [];
    const entries: Record<string, { fm: string[] }> = { "n.md": { fm: [] } };
    const candidates = Array.from({ length: 450 }, (_, i) => cand(i));
    for (const c of candidates) entries["n.md"]!.fm.push(c.from, c.to);
    const { controller, getState } = setup({
      classifier: fakeClassifier(async (req) => {
        const lines = req.user.split("\n");
        calls.push(lines.length);
        return lines.map((l) => {
          const id = l.match(/A: "(a\d+)"/)?.[1] ?? "";
          return { id: `${id}|b${id.slice(1)}`, verdict: "keep" } as Verdict;
        });
      }),
    }, entries);
    vi.spyOn(controller, "scan").mockResolvedValue({ totalTags: 900, singleUse: 0, dropped: 0, candidates });
    const res = await controller.classify();
    expect(calls).toHaveLength(10);
    expect(calls.every((n) => n === 20)).toBe(true);
    expect(res.judged).toBe(200);
    expect(res.dropped).toBe(250);
    expect(Object.keys(getState().verdicts)).toHaveLength(200);
  });

  it("stores verdicts with model and time, counts merge/keep, and scan attaches them", async () => {
    const { controller, getState } = setup({
      classifier: fakeClassifier(async (_req, _parse) => [{ id: pairKey("machine-learning", "ml"), verdict: "merge", canonical: "machine-learning" }]),
    }, CLASSIFY_NOTES);
    vi.spyOn(controller, "scan").mockResolvedValueOnce({
      totalTags: 2, singleUse: 0, dropped: 0,
      candidates: [{ ...cand(1), id: pairKey("machine-learning", "ml"), from: "ml", to: "machine-learning" }],
    });
    const res = await controller.classify();
    expect(res).toMatchObject({ judged: 1, merge: 1, keep: 0, failedBatches: 0, dropped: 0 });
    const stored = getState().verdicts[pairKey("machine-learning", "ml")];
    expect(stored).toEqual({ verdict: "merge", canonical: "machine-learning", a: "ml", b: "machine-learning", model: "m1", at: "2026-10-05T10:00:00.000Z" });
  });

  it("attaches stored verdicts to scan candidates by id", async () => {
    const { controller } = setup({}, NOTES);
    const id = pairKey("llm", "llms");
    await controller.dismiss("zz|yy");
    const first = await controller.scan();
    expect(first.candidates[0]?.verdict).toBeUndefined();
    const state = { dismissed: [], verdicts: { [id]: { verdict: "keep" as const, a: "llms", b: "llm", model: "m", at: "t" } } };
    const withVerdict = setup({ getState: () => state }, NOTES).controller;
    expect((await withVerdict.scan()).candidates[0]?.verdict?.verdict).toBe("keep");
  });

  it("counts a parse failure as one failed batch and continues; other errors end the run keeping stored verdicts", async () => {
    let n = 0;
    const candidates = Array.from({ length: 45 }, (_, i) => cand(i));
    const fm = candidates.flatMap((c) => [c.from, c.to]);
    const make = (third: unknown) => fakeClassifier(async (req) => {
      n++;
      if (n === 1) throw new VerdictParseError("bad");
      if (n === 3) throw third;
      const id = req.user.match(/"(a\d+)"/)?.[1] ?? "";
      return [{ id: `${id}|b${id.slice(1)}`, verdict: "keep" } as Verdict];
    });
    const a = setup({ classifier: make(new Error("network down")) }, { "n.md": { fm } });
    vi.spyOn(a.controller, "scan").mockResolvedValue({ totalTags: 90, singleUse: 0, dropped: 0, candidates });
    await expect(a.controller.classify()).rejects.toThrow("network down");
    expect(Object.keys(a.getState().verdicts)).toEqual(["a20|b20"]);

    n = 0;
    const b = setup({ classifier: make(new VerdictParseError("again")) }, { "n.md": { fm } });
    vi.spyOn(b.controller, "scan").mockResolvedValue({ totalTags: 90, singleUse: 0, dropped: 0, candidates });
    const res = await b.controller.classify();
    expect(res.failedBatches).toBe(2);
    expect(res.judged).toBe(1);
  });

  it("explicit run propagates a classifier() rejection", async () => {
    const { controller } = setup({}, NOTES);
    await expect(controller.classify()).rejects.toBeInstanceOf(UtilityUnavailableError);
  });

  it("never rewrites notes or writes a run note", async () => {
    const { controller, rewritten, writes } = setup({
      classifier: fakeClassifier(async () => [{ id: pairKey("llm", "llms"), verdict: "merge", canonical: "llm" }]),
    }, NOTES);
    vi.spyOn(controller, "scan").mockResolvedValue({ totalTags: 2, singleUse: 0, dropped: 0, candidates: [{ ...cand(1), id: pairKey("llm", "llms"), from: "llms", to: "llm" }] });
    await controller.classify();
    expect(rewritten).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("prunes verdicts whose tags no longer both exist", async () => {
    const stale = { verdict: "keep" as const, a: "gone", b: "llm", model: "m", at: "2026-10-01T00:00:00.000Z" };
    const { controller, getState } = setup({ classifier: fakeClassifier(async () => []) }, NOTES);
    await controller["deps"].setState({ dismissed: [], verdicts: { "gone|llm": stale } });
    await controller.classify();
    expect(getState().verdicts).toEqual({});
  });

  it("keeps dismissals and verdicts when dismissing", async () => {
    const { controller, getState } = setup({}, NOTES);
    const v = { verdict: "keep" as const, a: "llm", b: "llms", model: "m", at: "t" };
    await controller["deps"].setState({ dismissed: [], verdicts: { "llm|llms": v } });
    await controller.dismiss("q|r");
    expect(getState().verdicts["llm|llms"]).toEqual(v);
  });
});

describe("OptimizeController.classify background", () => {
  const bg = (over: Partial<Classifier>, extra: Partial<OptimizeDeps> = {}) => {
    const complete = vi.fn(async () => [] as Verdict[]);
    const s = setup({ classifier: fakeClassifier(complete, over), ...extra }, NOTES);
    return { ...s, complete };
  };

  it("resolves skipped:unavailable when classifier() rejects, never throws", async () => {
    const { controller } = setup({}, NOTES);
    expect(await controller.classify({ background: true })).toMatchObject({ skipped: "unavailable" });
  });

  it("skips a non-local classifier without calling it or stamping", async () => {
    const { controller, complete, getState } = bg({ local: false });
    expect(await controller.classify({ background: true })).toMatchObject({ skipped: "remote" });
    expect(complete).not.toHaveBeenCalled();
    expect(getState().lastBackgroundRun).toBeUndefined();
  });

  it("skips within 24h of the last run, runs after, and stamps even with zero pending", async () => {
    const { controller, getState } = bg({});
    await controller["deps"].setState({ dismissed: [], verdicts: {}, lastBackgroundRun: "2026-10-04T12:00:00.000Z" });
    expect(await controller.classify({ background: true })).toMatchObject({ skipped: "recent" });
    await controller["deps"].setState({ dismissed: [], verdicts: {}, lastBackgroundRun: "2026-10-04T09:00:00.000Z" });
    const res = await controller.classify({ background: true });
    expect(res.skipped).toBeUndefined();
    expect(getState().lastBackgroundRun).toBe("2026-10-05T10:00:00.000Z");
  });

  it("swallows a mid-run error", async () => {
    const { controller } = setup({ classifier: fakeClassifier(async () => { throw new Error("down"); }) }, NOTES);
    vi.spyOn(controller, "scan").mockResolvedValue({ totalTags: 2, singleUse: 0, dropped: 0, candidates: [cand(1)] });
    await expect(controller.classify({ background: true })).resolves.toMatchObject({ judged: 0 });
  });
});

describe("OptimizeController.classify lifecycle", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => cand(i));
  const withCandidates = (over: Partial<OptimizeDeps>, n: number) => {
    const candidates = many(n);
    const s = setup(over, { "n.md": { fm: candidates.flatMap((c) => [c.from, c.to]) } });
    vi.spyOn(s.controller, "scan").mockResolvedValue({ totalTags: n * 2, singleUse: 0, dropped: 0, candidates });
    return s;
  };
  const keepAll = (req: { user: string }): Verdict[] =>
    req.user.split("\n").map((l) => {
      const id = l.match(/A: "(a\d+)"/)?.[1] ?? "";
      return { id: `${id}|b${id.slice(1)}`, verdict: "keep" } as Verdict;
    });

  it("two overlapping background calls make one classifier call and the second is skipped:recent", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const classifier = vi.fn(fakeClassifier(async () => { await gate; return []; }));
    const { controller } = withCandidates({ classifier }, 1);
    const first = controller.classify({ background: true });
    const second = await controller.classify({ background: true });
    expect(second).toMatchObject({ skipped: "recent" });
    release();
    await first;
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it("an explicit call during a run returns the same in-flight result", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const classifier = vi.fn(fakeClassifier(async () => { await gate; return []; }));
    const { controller } = withCandidates({ classifier }, 1);
    const first = controller.classify({ background: true });
    const explicit = controller.classify();
    release();
    expect(await explicit).toBe(await first);
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it("a stamp later than now counts as no stamp", async () => {
    const complete = vi.fn(async () => [] as Verdict[]);
    const { controller } = setup({ classifier: fakeClassifier(complete) }, NOTES);
    vi.spyOn(controller, "scan").mockResolvedValue({ totalTags: 2, singleUse: 0, dropped: 0, candidates: [cand(1)] });
    await controller["deps"].setState({ dismissed: [], verdicts: {}, lastBackgroundRun: "2027-01-01T00:00:00.000Z" });
    const res = await controller.classify({ background: true });
    expect(res.skipped).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("an abort after batch 1 of 3 stops with that batch's verdicts stored", async () => {
    const ac = new AbortController();
    const complete = vi.fn(async (req: { user: string }) => {
      ac.abort();
      return keepAll(req);
    });
    const { controller, getState } = withCandidates({ classifier: fakeClassifier(complete as Classifier["complete"]) }, 50);
    const res = await controller.classify({ signal: ac.signal });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.judged).toBe(20);
    expect(Object.keys(getState().verdicts)).toHaveLength(20);
  });

  it("a ClassifierStoppedError on batch 2 writes no state; explicit rejects, background skips as stopped", async () => {
    const make = () => {
      let n = 0;
      return fakeClassifier(async (req) => {
        if (++n === 2) throw new ClassifierStoppedError("settings changed");
        return keepAll(req);
      });
    };
    const setStateSpy = vi.fn(async () => {});
    const explicit = withCandidates({ classifier: make(), setState: setStateSpy }, 50);
    await expect(explicit.controller.classify()).rejects.toBeInstanceOf(ClassifierStoppedError);
    const bgSet = vi.fn(async () => {});
    const background = withCandidates({ classifier: make(), setState: bgSet }, 50);
    expect(await background.controller.classify({ background: true })).toMatchObject({ skipped: "stopped" });
    expect(setStateSpy).not.toHaveBeenCalled();
    expect(bgSet).not.toHaveBeenCalled();
  });

  it("passes interactive from the call kind", async () => {
    const classifier = vi.fn(fakeClassifier(async () => []));
    const { controller } = setup({ classifier }, NOTES);
    await controller.classify();
    await controller.classify({ background: true });
    expect(classifier.mock.calls.map((c) => c[0])).toEqual([{ interactive: true }, { interactive: false }]);
  });
});

describe("OptimizeController.classifierInfo", () => {
  it("returns label and model, needsConfirmation for unavailable-loopback, and rethrows anything else", async () => {
    const ok = setup({ classifier: fakeClassifier(async () => []) }, NOTES);
    expect(await ok.controller.classifierInfo()).toEqual({ label: "Ollama", model: "m1" });
    const loop = new UtilityUnavailableError("x", { state: "unavailable-loopback", backend: "ollama", endpoint: "http://localhost:11434" });
    const gated = setup({ classifier: async () => { throw loop; } }, NOTES);
    expect(await gated.controller.classifierInfo()).toEqual({ needsConfirmation: true });
    const other = setup({}, NOTES);
    await expect(other.controller.classifierInfo()).rejects.toBeInstanceOf(UtilityUnavailableError);
  });
});

describe("OptimizeController state writes keep the type weave fields", () => {
  const typeFields = {
    typeVerdicts: { "a.md": { type: "project", model: "m", at: "2026-10-07T10:00:00.000Z", mtime: 4 } },
    dismissedTypes: ["z.md"],
  };

  it("dismiss, background classify and foreground classify keep typeVerdicts and dismissedTypes", async () => {
    let state: OptimizeState = { dismissed: [], verdicts: {}, ...typeFields };
    const { controller } = setup({
      getState: () => state,
      setState: async (next) => { state = next; },
      classifier: async () => ({ local: true, label: "l", model: "m", complete: async () => [] }),
    }, NOTES);
    await controller.dismiss("x|y");
    expect(state).toMatchObject(typeFields);
    await controller.classify({ background: true });
    expect(state).toMatchObject(typeFields);
    await controller.classify();
    expect(state).toMatchObject(typeFields);
  });
});

describe("OptimizeController state writes keep dismissedLinks", () => {
  it("dismiss and background classify spread the link dismissals through the normalizer", async () => {
    let state: OptimizeState = { dismissed: [], verdicts: {}, dismissedLinks: ["a.md\u0000b.md"] };
    const { controller } = setup({
      getState: () => state,
      setState: async (next) => { state = next; },
      classifier: async () => ({ local: true, label: "l", model: "m", complete: async () => [] }),
    }, NOTES);
    await controller.dismiss("x|y");
    expect(state.dismissedLinks).toEqual(["a.md\u0000b.md"]);
    await controller.classify({ background: true });
    expect(state.dismissedLinks).toEqual(["a.md\u0000b.md"]);
    expect(state.dismissed).toEqual(["x|y"]);
  });
});
