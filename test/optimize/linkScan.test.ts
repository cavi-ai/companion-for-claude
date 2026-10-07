import { describe, expect, it } from "vitest";
import { dismissalKey, findOrphans, MAX_NEIGHBOUR_LOOKUPS, scanOrphans, type LinkScanInput, type LinkScanNote, type NeighbourHit } from "../../src/optimize/linkScan";

const note = (path: string, over: Partial<LinkScanNote> = {}): LinkScanNote => ({
  path,
  basename: (path.split("/").pop() ?? path).replace(/\.md$/, ""),
  aliases: [],
  mtime: 1,
  acceptsRelated: true,
  ...over,
});

function setup(notes: LinkScanNote[], files: Record<string, string>, over: Partial<LinkScanInput> = {}) {
  const reads: string[] = [];
  const input: LinkScanInput = {
    notes,
    edges: {},
    ontologyFolder: "Ontology",
    dismissed: new Set(),
    read: async (path) => {
      reads.push(path);
      return files[path] ?? "";
    },
    neighbours: async () => [],
    yieldEvery: async () => undefined,
    ...over,
  };
  return { input, reads };
}

describe("findOrphans", () => {
  const notes = [note("a.md"), note("b.md"), note("c.md"), note("d.md")];

  it("counts md-to-md edges in either direction and ignores self-links", () => {
    expect(findOrphans(notes, { "a.md": { "b.md": 1, "a.md": 3 }, "c.md": { "c.md": 1 } }, "")).toEqual(["c.md", "d.md"]);
  });

  it("ignores non-markdown targets, zero counts, and edges from unknown sources", () => {
    expect(findOrphans(notes, { "a.md": { "pic.png": 1, "b.md": 0 }, "ghost.md": { "d.md": 1 } }, "")).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("never lists generated or ontology notes, but they still count as link endpoints", () => {
    const all = [note("a.md"), note("t.md", { type: "triage" }), note("o.md", { type: "order-run" }), note("r.md", { type: "optimize-run" }), note("Ontology/person.md"), note("Ontologyx/p.md")];
    expect(findOrphans(all, {}, "Ontology")).toEqual(["a.md", "Ontologyx/p.md"]);
    expect(findOrphans(all, { "t.md": { "a.md": 1 } }, "Ontology")).toEqual(["Ontologyx/p.md"]);
  });
});

describe("scanOrphans", () => {
  it("proposes an inbound link for the first mention in another note, with the target's link text", async () => {
    const notes = [note("Café Notes.md"), note("daily.md")];
    const { input } = setup(notes, { "Café Notes.md": "alone", "daily.md": "Met about café notes today." });
    input.edges = { "daily.md": { "hub.md": 1 } };
    input.notes.push(note("hub.md"));
    const report = await scanOrphans(input);
    expect(report.orphanCount).toBe(1);
    const inbound = report.groups.flatMap((g) => g.proposals).filter((p) => p.kind === "inbound");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ orphan: "Café Notes.md", source: "daily.md", target: "Café Notes.md", linktext: "Café Notes", checked: true });
    expect(inbound[0]?.mention?.surface).toBe("café notes");
    expect([...report.contents.keys()]).toEqual(["daily.md"]);
  });

  it("proposes an outbound link when the orphan's body names another note, emoji basename included", async () => {
    const notes = [note("lonely.md"), note("🧠 Brain.md"), note("hub.md")];
    const edges = { "hub.md": { "🧠 Brain.md": 1 } };
    const { input } = setup(notes, { "lonely.md": "I read about 🧠 Brain yesterday.", "🧠 Brain.md": "", "hub.md": "" }, { edges });
    const report = await scanOrphans(input);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.path).toBe("lonely.md");
    expect(report.groups[0]?.proposals[0]).toMatchObject({ kind: "outbound", source: "lonely.md", target: "🧠 Brain.md", linktext: "🧠 Brain", checked: true });
  });

  it("uses the path as link text when two folders share the basename", async () => {
    const notes = [note("lonely.md"), note("a/Idea.md"), note("b/Idea.md"), note("hub.md")];
    const edges = { "hub.md": { "a/Idea.md": 1, "b/Idea.md": 1 } };
    const { input } = setup(notes, { "lonely.md": "An Idea appears." }, { edges });
    const report = await scanOrphans(input);
    const first = report.groups[0]?.proposals[0];
    expect(first?.linktext).toMatch(/^(a|b)\/Idea$/);
  });

  it("matches digits in a basename only when it is not a non-target name", async () => {
    const notes = [note("lonely.md"), note("2026-10-05.md"), note("Untitled 3.md"), note("2024.md"), note("Plan 9.md"), note("hub.md")];
    const edges = { "hub.md": { "2026-10-05.md": 1, "Untitled 3.md": 1, "2024.md": 1, "Plan 9.md": 1 } };
    const { input } = setup(notes, { "lonely.md": "2026-10-05 Untitled 3 2024 Plan 9" }, { edges });
    const report = await scanOrphans(input);
    expect(report.groups[0]?.proposals.map((p) => p.target)).toEqual(["Plan 9.md"]);
  });

  it("caps inbound proposals at 3 per orphan, newest notes first", async () => {
    const notes = [note("Target.md"), ...["n1", "n2", "n3", "n4", "n5"].map((n, i) => note(`${n}.md`, { mtime: i + 1 })), note("hub.md")];
    const files: Record<string, string> = {};
    for (const n of ["n1", "n2", "n3", "n4", "n5"]) files[`${n}.md`] = "see Target here";
    const edges = Object.fromEntries(["n1", "n2", "n3", "n4", "n5"].map((n) => [`${n}.md`, { "hub.md": 1 }]));
    const { input, reads } = setup(notes, files, { edges });
    const report = await scanOrphans(input);
    const inbound = report.groups.find((g) => g.path === "Target.md")?.proposals ?? [];
    expect(inbound.map((p) => p.source)).toEqual(["n5.md", "n4.md", "n3.md"]);
    expect(reads.filter((p) => p === "n5.md")).toHaveLength(1);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("caps outbound proposals at 3 per orphan", async () => {
    const targets = ["Alpha", "Beta", "Gamma", "Delta"].map((n) => note(`${n}.md`));
    const notes = [note("lonely.md"), ...targets, note("hub.md")];
    const edges = { "hub.md": Object.fromEntries(targets.map((t) => [t.path, 1])) };
    const { input } = setup(notes, { "lonely.md": "Alpha Beta Gamma Delta" }, { edges });
    const report = await scanOrphans(input);
    expect(report.groups[0]?.proposals.map((p) => p.target)).toEqual(["Alpha.md", "Beta.md", "Gamma.md"]);
  });

  it("reads each note at most once", async () => {
    const notes = [note("a.md"), note("b.md"), note("c.md")];
    const { input, reads } = setup(notes, { "a.md": "b c", "b.md": "a", "c.md": "a b" });
    await scanOrphans(input);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("never edits or links generated and ontology notes", async () => {
    const notes = [note("Subject.md"), note("log.md", { type: "triage" }), note("Ontology/Topic Schema.md"), note("lonely.md"), note("hub.md")];
    const files = { "log.md": "Subject", "Ontology/Topic Schema.md": "Subject", "lonely.md": "Topic Schema and log" };
    const edges = { "hub.md": { "Subject.md": 1 } };
    const { input, reads } = setup(notes, files, { edges });
    const report = await scanOrphans(input);
    expect(report.groups).toEqual([]);
    expect(reads).not.toContain("log.md");
    expect(reads).not.toContain("Ontology/Topic Schema.md");
  });

  it("applies dismissals to inbound, outbound and related by exact path pair", async () => {
    const notes = [note("Orphan.md"), note("src.md"), note("Tgt.md"), note("Rel.md"), note("hub.md")];
    const files = { "src.md": "Orphan", "Orphan.md": "mentions Tgt" };
    const edges = { "src.md": { "hub.md": 1 }, "Tgt.md": { "hub.md": 1 }, "Rel.md": { "hub.md": 1 } };
    const neighbours = async (_p: string, accept: (p: string) => boolean): Promise<NeighbourHit[]> => [{ path: "Rel.md", score: 0.9 }].filter((h) => accept(h.path));
    const dismissed = new Set([dismissalKey("src.md", "Orphan.md"), dismissalKey("Orphan.md", "Tgt.md"), dismissalKey("Orphan.md", "Rel.md")]);
    const report = await scanOrphans(setup(notes, files, { edges, dismissed, neighbours }).input);
    expect(report.groups).toEqual([]);
    const open = await scanOrphans(setup(notes, files, { edges, neighbours }).input);
    expect(open.groups[0]?.proposals.map((p) => p.kind).sort()).toEqual(["inbound", "outbound", "related"]);
    const sibling = new Set([dismissalKey("src.md", "Orphan.md").replace("src.md", "other.md")]);
    expect((await scanOrphans(setup(notes, files, { edges, dismissed: sibling, neighbours }).input)).groups).toHaveLength(1);
  });

  it("proposes related notes unchecked, at or above 0.5, top 3, eligible targets only", async () => {
    const notes = [note("lonely.md"), note("A.md"), note("B.md"), note("C.md"), note("D.md"), note("T.md", { type: "optimize-run" }), note("hub.md")];
    const edges = { "hub.md": { "A.md": 1, "B.md": 1, "C.md": 1, "D.md": 1, "T.md": 1 } };
    const seen: Array<(p: string) => boolean> = [];
    const neighbours = async (_p: string, accept: (p: string) => boolean): Promise<NeighbourHit[]> => {
      seen.push(accept);
      return [{ path: "A.md", score: 0.9 }, { path: "T.md", score: 0.85 }, { path: "B.md", score: 0.8 }, { path: "C.md", score: 0.7 }, { path: "D.md", score: 0.6 }, { path: "hub.md", score: 0.49 }].filter((h) => accept(h.path));
    };
    const report = await scanOrphans(setup(notes, {}, { edges, neighbours }).input);
    const related = report.groups[0]?.proposals ?? [];
    expect(related.map((p) => [p.target, p.score, p.checked, p.kind])).toEqual([
      ["A.md", 0.9, false, "related"],
      ["B.md", 0.8, false, "related"],
      ["C.md", 0.7, false, "related"],
    ]);
    expect(seen[0]?.("lonely.md")).toBe(false);
  });

  it("is silent about related for an orphan that is not indexed or whose type declares no related relation", async () => {
    const notes = [note("a.md", { acceptsRelated: false }), note("b.md"), note("hub.md")];
    const edges = { "hub.md": { "b.md": 1 } };
    let calls = 0;
    const neighbours = async (): Promise<NeighbourHit[]> => {
      calls++;
      return [];
    };
    const report = await scanOrphans(setup(notes, {}, { edges, neighbours }).input);
    expect(report.groups).toEqual([]);
    expect(calls).toBe(0);
  });

  it("does not repeat an outbound link as a related row", async () => {
    const notes = [note("lonely.md"), note("Alpha.md"), note("hub.md")];
    const edges = { "hub.md": { "Alpha.md": 1 } };
    const neighbours = async (_p: string, accept: (p: string) => boolean): Promise<NeighbourHit[]> => [{ path: "Alpha.md", score: 0.9 }].filter((h) => accept(h.path));
    const report = await scanOrphans(setup(notes, { "lonely.md": "Alpha" }, { edges, neighbours }).input);
    expect(report.groups[0]?.proposals.map((p) => p.kind)).toEqual(["outbound"]);
  });

  it("keeps orphans with at least one proposal, ranked by mention count, mtime then path, capped at 50 with the rest counted", async () => {
    const orphans = Array.from({ length: 53 }, (_, i) => note(`o${String(i).padStart(2, "0")}.md`));
    const notes = [...orphans, note("hub.md")];
    const neighbours = async (path: string, accept: (p: string) => boolean): Promise<NeighbourHit[]> => {
      const hits: NeighbourHit[] = [{ path: "hub.md", score: 0.9 }];
      if (path === "o52.md") hits.push({ path: "o00.md", score: 0.8 });
      return hits.filter((h) => accept(h.path));
    };
    const report = await scanOrphans(setup(notes, {}, { neighbours }).input);
    expect(report.orphanCount).toBe(54);
    expect(report.groups).toHaveLength(50);
    expect(report.groups[0]?.path).toBe("o00.md");
    expect(report.groups[0]?.proposals.map((p) => p.target)).toEqual(["hub.md"]);
    expect(report.remaining).toBe(4);
  });

  it("reviews orphans with mention proposals before related-only ones, then newest first", async () => {
    const notes = [note("old.md", { mtime: 1 }), note("new.md", { mtime: 9 }), note("Mentioned.md", { mtime: 5 }), note("hub.md"), note("daily.md", { mtime: 2 })];
    const edges = { "daily.md": { "hub.md": 1 } };
    const looked: string[] = [];
    const neighbours = async (path: string): Promise<NeighbourHit[]> => {
      looked.push(path);
      return [{ path: "hub.md", score: 0.9 }];
    };
    const report = await scanOrphans(setup(notes, { "daily.md": "see Mentioned here" }, { edges, neighbours }).input);
    expect(report.groups.map((g) => g.path)).toEqual(["Mentioned.md", "new.md", "old.md"]);
    expect(looked).toEqual(["Mentioned.md", "new.md", "old.md"]);
    expect(report.remaining).toBe(0);
  });

  it("stops neighbour lookups once 50 groups are filled", async () => {
    const notes = [...Array.from({ length: 120 }, (_, i) => note(`o${String(i).padStart(3, "0")}.md`)), note("hub.md"), note("side.md")];
    let calls = 0;
    const neighbours = async (): Promise<NeighbourHit[]> => {
      calls += 1;
      return [{ path: "hub.md", score: 0.9 }];
    };
    const report = await scanOrphans(setup(notes, {}, { edges: { "hub.md": { "side.md": 1 } }, neighbours }).input);
    expect(report.groups).toHaveLength(50);
    expect(calls).toBe(50);
    expect(report.remaining).toBe(70);
  });

  it("never exceeds 200 neighbour lookups when most orphans have nothing to propose", async () => {
    const notes = Array.from({ length: 500 }, (_, i) => note(`o${String(i).padStart(3, "0")}.md`));
    let calls = 0;
    const neighbours = async (): Promise<NeighbourHit[]> => {
      calls += 1;
      return [];
    };
    const report = await scanOrphans(setup(notes, {}, { neighbours }).input);
    expect(calls).toBe(MAX_NEIGHBOUR_LOOKUPS);
    expect(report.groups).toEqual([]);
    expect(report.remaining).toBe(500);
  });

  it("yields after every 10 neighbour lookups", async () => {
    const notes = [...Array.from({ length: 25 }, (_, i) => note(`o${String(i).padStart(2, "0")}.md`)), note("hub.md"), note("side.md")];
    let yields = 0;
    const neighbours = async (): Promise<NeighbourHit[]> => [{ path: "hub.md", score: 0.9 }];
    const report = await scanOrphans(setup(notes, {}, { edges: { "hub.md": { "side.md": 1 } }, neighbours, yieldEvery: async () => void (yields += 1) }).input);
    expect(report.groups).toHaveLength(25);
    expect(yields).toBe(2);
  });

  it("yields once per 50 notes read and reports progress", async () => {
    const notes = Array.from({ length: 120 }, (_, i) => note(`n${String(i).padStart(3, "0")}.md`));
    const edges = Object.fromEntries(notes.slice(1).map((n, i) => [n.path, { [notes[1 + ((i + 1) % 119)]!.path]: 1 }]));
    let yields = 0;
    const progress: Array<[number, number]> = [];
    const report = await scanOrphans(setup(notes, {}, { edges, yieldEvery: async () => void (yields += 1), onProgress: (d, t) => progress.push([d, t]) }).input);
    expect(report.orphanCount).toBe(1);
    expect(yields).toBe(2);
    expect(progress).toEqual([[50, 120], [100, 120]]);
  });

  it("reads nothing when the vault has no orphan", async () => {
    const { input, reads } = setup([note("a.md"), note("b.md")], {}, { edges: { "a.md": { "b.md": 1 } } });
    expect((await scanOrphans(input)).groups).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("scans 5,000 notes with 2 KB bodies in one read each, at most 200 neighbour lookups and 50 groups", async () => {
    const orphanNames = Array.from({ length: 500 }, (_, i) => `Zorb${String(i).padStart(4, "0")}`);
    const plainNames = Array.from({ length: 4500 }, (_, i) => `Plain${String(i).padStart(4, "0")}`);
    const notes = [...orphanNames.map((n) => note(`${n}.md`)), ...plainNames.map((n) => note(`${n}.md`))];
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(37);
    const files: Record<string, string> = {};
    for (const n of orphanNames) files[`${n}.md`] = filler;
    plainNames.forEach((n, i) => {
      files[`${n}.md`] = i < 1000 ? `${filler}\nRelated to ${orphanNames[i % 500]} today.` : filler;
    });
    const edges = Object.fromEntries(plainNames.map((n, i) => [`${n}.md`, { [`${plainNames[(i + 1) % 4500]}.md`]: 1 }]));
    let lookups = 0;
    const neighbours = async (): Promise<NeighbourHit[]> => {
      lookups += 1;
      return [0, 1, 2].map((i) => ({ path: `${plainNames[i]}.md`, score: 0.9 - i / 100 }));
    };
    const { input, reads } = setup(notes, files, { edges, neighbours, yieldEvery: async () => undefined });
    const report = await scanOrphans(input);
    expect(report.orphanCount).toBe(500);
    expect(reads).toHaveLength(5000);
    expect(new Set(reads).size).toBe(5000);
    expect(MAX_NEIGHBOUR_LOOKUPS).toBe(200);
    expect(lookups).toBeLessThanOrEqual(MAX_NEIGHBOUR_LOOKUPS);
    expect(report.groups).toHaveLength(50);
  }, 60_000); // ~4 s alone, ~16 s under parallel load: above the 15 s default timeout
});
