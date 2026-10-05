import { describe, expect, it } from "vitest";
import { findUnlinkedMentions, withLinktext } from "../../src/links/unlinkedMentions";
import { formatLinkApplyNotice, formatLinkScanEmptyNotice, LinkWeaveController, type LinkWeaveDeps, type RelatedWrite } from "../../src/optimize/linkController";
import { mergeRelated } from "../../src/optimize/linkPlan";
import { dismissalKey, type LinkProposal, type LinkScanReport } from "../../src/optimize/linkScan";
import { normalizeOptimizeState, type OptimizeState } from "../../src/optimize/state";

function body(kind: "inbound" | "outbound", source: string, content: string, targets: string[], target: string, checked = true): LinkProposal {
  const candidates = withLinktext(targets.map((t) => ({ path: t, basename: (t.split("/").pop() ?? t).replace(/\.md$/, ""), aliases: [] })));
  const m = findUnlinkedMentions(content, candidates, source).find((x) => x.path === target)!;
  return { id: `${kind}\u0000${source}\u0000${target}`, kind, orphan: kind === "inbound" ? target : source, source, target, linktext: m.target, mention: m, checked };
}

const relatedRow = (source: string, target: string, linktext: string): LinkProposal => ({ id: `related\u0000${source}\u0000${target}`, kind: "related", orphan: source, source, target, linktext, score: 0.8, checked: true });

function setup(files: Record<string, string>, fm: Record<string, unknown> = {}, over: Partial<LinkWeaveDeps> = {}) {
  let state: OptimizeState = { dismissed: ["t|u"], verdicts: { "a|b": { verdict: "keep", a: "a", b: "b", model: "m", at: "t" } }, lastBackgroundRun: "2026-10-05T00:00:00.000Z" };
  const processed: string[] = [];
  const frontmatter: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(fm).map(([k, v]) => [k, { related: v }]));
  const runNotes: string[] = [];
  const scans: Array<ReadonlySet<string>> = [];
  const deps: LinkWeaveDeps = {
    scan: async (dismissed) => {
      scans.push(dismissed);
      return { orphanCount: 0, groups: [], remaining: 0, contents: new Map() } satisfies LinkScanReport;
    },
    processBody: async (path, transform) => {
      processed.push(path);
      files[path] = transform(files[path] ?? "");
    },
    addRelated: async (path, entries): Promise<RelatedWrite> => {
      const merged = mergeRelated(frontmatter[path]?.related, entries);
      if (!merged.ok) return merged;
      if (merged.added.length > 0) frontmatter[path] = { ...frontmatter[path], related: merged.value };
      return { ok: true, added: merged.added };
    },
    writeRunNote: async (content) => {
      runNotes.push(content);
      return "Claude/Optimize/Link weave.md";
    },
    getState: () => state,
    setState: async (next) => {
      state = next;
    },
    now: () => "2026-10-05T10:00:00.000Z",
    ...over,
  };
  return { controller: new LinkWeaveController(deps), files, frontmatter, processed, runNotes, scans, getState: () => state };
}

describe("LinkWeaveController.apply", () => {
  it("writes only the rows it is given and leaves every other note untouched", async () => {
    const files = { "a.md": "Alpha and Beta here.", "b.md": "Beta stays Alpha." };
    const rows = [body("outbound", "a.md", files["a.md"], ["Alpha.md", "Beta.md"], "Beta.md")];
    const ctx = setup({ ...files });
    const result = await ctx.controller.apply(rows, new Map([["a.md", files["a.md"]]]));
    expect(ctx.files["a.md"]).toBe("Alpha and [[Beta]] here.");
    expect(ctx.files["b.md"]).toBe(files["b.md"]);
    expect(ctx.processed).toEqual(["a.md"]);
    expect(result).toMatchObject({ links: 1, notes: 1, conflicts: [], failed: [], runNote: "Claude/Optimize/Link weave.md" });
  });

  it("applies inbound and related rows, merging related into the existing list in order", async () => {
    const files = { "n.md": "talks about Café today", "o.md": "orphan body" };
    const rows = [body("inbound", "n.md", files["n.md"], ["Café.md"], "Café.md"), relatedRow("o.md", "p.md", "p"), relatedRow("o.md", "q.md", "folder/q")];
    const ctx = setup({ ...files }, { "o.md": ["[[Zed]]", 3] });
    const result = await ctx.controller.apply(rows, new Map([["n.md", files["n.md"]]]));
    expect(ctx.files["n.md"]).toBe("talks about [[Café]] today");
    expect(ctx.frontmatter["o.md"]?.related).toEqual(["[[Zed]]", 3, "[[p]]", "[[folder/q]]"]);
    expect(result.links).toBe(3);
    expect(result.notes).toBe(2);
  });

  it("skips a note that changed since the scan, including its related additions, and reports it", async () => {
    const original = "Alpha mention here.";
    const ctx = setup({ "a.md": "Alpha mention here. EDITED" });
    const rows = [body("outbound", "a.md", original, ["Alpha.md"], "Alpha.md"), relatedRow("a.md", "r.md", "r")];
    const result = await ctx.controller.apply(rows, new Map([["a.md", original]]));
    expect(ctx.files["a.md"]).toBe("Alpha mention here. EDITED");
    expect(ctx.frontmatter["a.md"]).toBeUndefined();
    expect(result).toMatchObject({ links: 0, notes: 0, conflicts: ["a.md"], runNote: null });
    expect(ctx.runNotes).toEqual([]);
  });

  it("skips a note whose related is not a list and reports it, keeping its body edit", async () => {
    const content = "Alpha here.";
    const rows = [body("outbound", "a.md", content, ["Alpha.md"], "Alpha.md"), relatedRow("a.md", "r.md", "r")];
    const ctx = setup({ "a.md": content }, { "a.md": { nested: true } });
    const result = await ctx.controller.apply(rows, new Map([["a.md", content]]));
    expect(ctx.files["a.md"]).toBe("[[Alpha]] here.");
    expect(result.failed).toEqual([{ path: "a.md", message: "related is not a list" }]);
    expect(result.links).toBe(1);
  });

  it("does not count a related row whose link was already present, and writes no run note when nothing was added", async () => {
    const ctx = setup({}, { "o.md": "[[p|alias]]" });
    const result = await ctx.controller.apply([relatedRow("o.md", "p.md", "p")], new Map());
    expect(result).toMatchObject({ links: 0, notes: 0, runNote: null });
    expect(ctx.frontmatter["o.md"]?.related).toBe("[[p|alias]]");
  });

  it("puts an approved related row whose write added nothing in failed", async () => {
    const ctx = setup({}, { "o.md": "[[p|alias]]" });
    const result = await ctx.controller.apply([relatedRow("o.md", "p.md", "p")], new Map());
    expect(result.failed).toEqual([{ path: "o.md", message: "p.md: already in related" }]);
  });

  it("links an approved row next to a plain-text value of the same name", async () => {
    const ctx = setup({}, { "o.md": "p" });
    const result = await ctx.controller.apply([relatedRow("o.md", "p.md", "p")], new Map());
    expect(result).toMatchObject({ links: 1, failed: [] });
    expect(ctx.frontmatter["o.md"]?.related).toEqual(["p", "[[p]]"]);
  });

  it("isolates a failing note and still applies the others", async () => {
    const a = "Alpha here.";
    const b = "Beta here.";
    const ctx = setup({ "a.md": a, "b.md": b }, {}, {
      processBody: async (path, transform) => {
        if (path === "a.md") throw new Error("disk full");
        ctx.files[path] = transform(ctx.files[path] ?? "");
      },
    });
    const rows = [body("outbound", "a.md", a, ["Alpha.md"], "Alpha.md"), body("outbound", "b.md", b, ["Beta.md"], "Beta.md"), relatedRow("a.md", "r.md", "r")];
    const result = await ctx.controller.apply(rows, new Map([["a.md", a], ["b.md", b]]));
    expect(ctx.files["b.md"]).toBe("[[Beta]] here.");
    expect(result.failed).toEqual([{ path: "a.md", message: "disk full" }]);
    expect(ctx.frontmatter["a.md"]).toBeUndefined();
    expect(result.links).toBe(1);
  });

  it("records a related write that throws as a failure", async () => {
    const ctx = setup({}, {}, { addRelated: async () => { throw new Error("locked"); } });
    const result = await ctx.controller.apply([relatedRow("o.md", "p.md", "p")], new Map());
    expect(result.failed).toEqual([{ path: "o.md", message: "locked" }]);
  });

  it("writes the run note with code-span paths only, even when the paths hold wikilink brackets", async () => {
    const content = "Alpha here.";
    const ctx = setup({ "[[odd]].md": content });
    await ctx.controller.apply([body("outbound", "[[odd]].md", content, ["Alpha.md"], "Alpha.md")], new Map([["[[odd]].md", content]]));
    expect(ctx.runNotes).toHaveLength(1);
    expect(ctx.runNotes[0]).not.toContain("[[");
    expect(ctx.runNotes[0]).toContain("(outbound)");
  });

  it("still reports the links when the run note cannot be written", async () => {
    const content = "Alpha here.";
    const ctx = setup({ "a.md": content }, {}, { writeRunNote: async () => { throw new Error("no folder"); } });
    const result = await ctx.controller.apply([body("outbound", "a.md", content, ["Alpha.md"], "Alpha.md")], new Map([["a.md", content]]));
    expect(result).toMatchObject({ links: 1, runNote: null });
  });

  it("does nothing for an empty selection", async () => {
    const ctx = setup({ "a.md": "x" });
    expect(await ctx.controller.apply([], new Map())).toEqual({ links: 0, notes: 0, conflicts: [], failed: [], runNote: null });
    expect(ctx.processed).toEqual([]);
  });
});

describe("LinkWeaveController dismissals and state", () => {
  it("passes the persisted dismissals to the scan", async () => {
    const ctx = setup({});
    await ctx.controller.dismiss({ source: "a.md", target: "b.md" });
    await ctx.controller.scan();
    expect([...ctx.scans[0]!]).toEqual([dismissalKey("a.md", "b.md")]);
  });

  it("dismiss keeps dismissed, verdicts and lastBackgroundRun, and dedupes", async () => {
    const ctx = setup({});
    await ctx.controller.dismiss({ source: "a.md", target: "b.md" });
    await ctx.controller.dismiss({ source: "a.md", target: "b.md" });
    expect(ctx.getState()).toEqual(normalizeOptimizeState({
      dismissed: ["t|u"],
      verdicts: { "a|b": { verdict: "keep", a: "a", b: "b", model: "m", at: "t" } },
      lastBackgroundRun: "2026-10-05T00:00:00.000Z",
      dismissedLinks: [dismissalKey("a.md", "b.md")],
    }));
    expect(ctx.getState().dismissedLinks).toHaveLength(1);
    expect(ctx.getState().lastBackgroundRun).toBe("2026-10-05T00:00:00.000Z");
    expect(Object.keys(ctx.getState().verdicts)).toEqual(["a|b"]);
  });

  it("dismissing never writes a note, the run note, or any link", async () => {
    const ctx = setup({ "a.md": "x" });
    await ctx.controller.dismiss({ source: "a.md", target: "b.md" });
    expect(ctx.processed).toEqual([]);
    expect(ctx.runNotes).toEqual([]);
    expect(ctx.files).toEqual({ "a.md": "x" });
  });
});

describe("formatLinkScanEmptyNotice", () => {
  it("separates no orphans from orphans without a proposal", () => {
    expect(formatLinkScanEmptyNotice({ orphanCount: 0 })).toBe("No orphan notes to connect.");
    expect(formatLinkScanEmptyNotice({ orphanCount: 1 })).toBe("1 orphan note, none with a link to propose.");
    expect(formatLinkScanEmptyNotice({ orphanCount: 4 })).toBe("4 orphan notes, none with a link to propose.");
  });
});

describe("formatLinkApplyNotice", () => {
  it("states links, notes, conflicts and failures", () => {
    expect(formatLinkApplyNotice({ links: 1, notes: 1, conflicts: [], failed: [], runNote: null })).toBe("Added 1 link across 1 note");
    expect(formatLinkApplyNotice({ links: 3, notes: 2, conflicts: ["a.md"], failed: [{ path: "b.md", message: "x" }], runNote: "r.md" })).toBe(
      "Added 3 links across 2 notes, 1 note changed since the review and left alone, 1 link not added",
    );
  });
});
