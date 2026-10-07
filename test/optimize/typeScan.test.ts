import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTypes } from "../../src/ontology/schema";
import { SEED_TYPES } from "../../src/ontology/seed";
import type { ResolvedType, TypeDef } from "../../src/ontology/types";
import type { StoredTypeVerdict } from "../../src/optimize/state";
import {
  conformanceLine,
  MAX_TYPE_ROWS,
  PLUGIN_OWNED_TYPES,
  proposableTypes,
  scanUntyped,
  type TypeRegistry,
  type TypeScanInput,
  type TypeScanNote,
} from "../../src/optimize/typeScan";

function registryOf(defs: TypeDef[]): TypeRegistry {
  const { resolved } = resolveTypes(defs);
  return { resolve: (n) => resolved.get(n), resolved: () => resolved as ReadonlyMap<string, ResolvedType> };
}

const entity: TypeDef = { name: "entity", version: 1, properties: [], relations: [] };
const def = (name: string, over: Partial<TypeDef> = {}): TypeDef => ({ name, version: 1, extendsType: "entity", properties: [], relations: [], ...over });
const registry = registryOf([entity, def("project"), def("person"), def("concept")]);

const note = (path: string, over: Partial<TypeScanNote> = {}): TypeScanNote => ({ path, mtime: 1, frontmatter: undefined, tags: [], ...over });
const typed = (path: string, type: unknown): TypeScanNote => note(path, { frontmatter: { type } });

function scan(notes: TypeScanNote[], over: Partial<TypeScanInput> = {}) {
  return scanUntyped({ notes, registry, ontologyFolder: "Ontology", dismissed: new Set(), verdicts: {}, ...over });
}

const projectFolder = (n: number, other = 0): TypeScanNote[] => [
  ...Array.from({ length: n }, (_, i) => typed(`Projects/p${i}.md`, "project")),
  ...Array.from({ length: other }, (_, i) => typed(`Projects/o${i}.md`, "person")),
];

describe("proposableTypes", () => {
  it("drops the root, generated, and plugin-owned types, sorted", () => {
    const { resolved } = resolveTypes([...SEED_TYPES, def("triage"), def("optimize-run"), def("order-run"), def("zebra"), def("apple")]);
    const names = proposableTypes({ resolve: (n) => resolved.get(n), resolved: () => resolved as ReadonlyMap<string, ResolvedType> });
    expect(names).toContain("person");
    expect(names).toContain("project");
    for (const hidden of ["entity", "triage", "order-run", "optimize-run", ...PLUGIN_OWNED_TYPES]) expect(names).not.toContain(hidden);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("is empty without a registry", () => {
    expect(proposableTypes(null)).toEqual([]);
  });
});

describe("scanUntyped status", () => {
  it("reports no registry only when the ontology is off; an empty or non-proposable registry is no-types", () => {
    expect(scan([note("a.md")], { registry: null }).status).toBe("no-registry");
    expect(scan([note("a.md")], { registry: registryOf([]) }).status).toBe("no-types");
    expect(scan([note("a.md")], { registry: registryOf([entity, def("claim"), def("triage")]) }).status).toBe("no-types");
  });
});

describe("candidates", () => {
  it("treats a missing type, an empty frontmatter, no frontmatter and type: null as candidates; any other value as typed", () => {
    const report = scan([
      note("none.md"),
      note("nofm.md", { frontmatter: {} }),
      typed("null.md", null),
      typed("num.md", 3),
      typed("list.md", ["project"]),
      typed("obj.md", {}),
      typed("empty.md", ""),
      typed("str.md", "project"),
    ]);
    expect(report.candidates).toBe(3);
  });

  it("excludes the ontology folder, Claude/Optimize, and dismissed paths", () => {
    const report = scan(
      [note("Ontology/x.md"), note("Claude/Optimize/run.md"), note("Dismissed.md"), note("Ontologyx/keep.md"), note("keep.md")],
      { dismissed: new Set(["Dismissed.md"]) },
    );
    expect(report.candidates).toBe(2);
  });

  it("handles non-ASCII, emoji and digit paths", () => {
    const report = scan([...projectFolder(3), note("Projects/Café.md"), note("Projects/🧠 2024.md")]);
    expect(report.proposals.map((p) => p.path).sort()).toEqual(["Projects/Café.md", "Projects/🧠 2024.md"]);
  });
});

describe("folder evidence", () => {
  it("proposes when the folder holds at least 3 typed notes and 80% share one type", () => {
    const report = scan([...projectFolder(4), ...projectFolder(0, 1).map((n) => ({ ...n, path: `Projects/zz.md` })), note("Projects/new.md")]);
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]).toMatchObject({
      path: "Projects/new.md",
      type: "project",
      evidence: [{ kind: "folder", text: "folder: 4 of 5 typed notes in Projects/ are project" }],
    });
  });

  it("does not propose under 3 typed notes or under 80%", () => {
    expect(scan([...projectFolder(2), note("Projects/new.md")]).proposals).toEqual([]);
    expect(scan([...projectFolder(3, 1), note("Projects/new.md")]).proposals).toEqual([]);
  });

  it("counts only typed notes with proposable types, exact folder not recursive", () => {
    const notes = [
      typed("Projects/a.md", "project"),
      typed("Projects/b.md", "project"),
      typed("Projects/c.md", "claim"),
      typed("Projects/d.md", "entity"),
      typed("Projects/sub/e.md", "project"),
      note("Projects/new.md"),
    ];
    expect(scan(notes).proposals).toEqual([]);
  });

  it("works in the vault root", () => {
    const notes = [typed("a.md", "person"), typed("b.md", "person"), typed("c.md", "person"), note("new.md")];
    expect(scan(notes).proposals[0]?.evidence).toEqual([{ kind: "folder", text: "folder: 3 of 3 typed notes in the vault root are person" }]);
  });
});

describe("tag evidence", () => {
  it("matches a tag equal to a type name or the name plus s, case-insensitively, with or without #", () => {
    const report = scan([
      note("a.md", { tags: ["#Project"] }),
      note("b.md", { tags: ["people"] }),
      note("c.md", { tags: ["persons"] }),
      note("d.md", { tags: ["concepts"] }),
    ]);
    const byPath = Object.fromEntries(report.proposals.map((p) => [p.path, p]));
    expect(byPath["a.md"]).toMatchObject({ type: "project", evidence: [{ kind: "tag", text: "tag: #project" }] });
    expect(byPath["b.md"]).toBeUndefined();
    expect(byPath["c.md"]?.type).toBe("person");
    expect(byPath["d.md"]?.type).toBe("concept");
  });

  it("two different types in tags give no tag evidence", () => {
    expect(scan([note("a.md", { tags: ["project", "person"] })]).proposals).toEqual([]);
  });

  it("the same type twice is still one type", () => {
    expect(scan([note("a.md", { tags: ["project", "projects"] })]).proposals[0]?.type).toBe("project");
  });

  it("ignores tags that name a hidden type", () => {
    expect(scan([note("a.md", { tags: ["claim", "entity", "chat"] })]).proposals).toEqual([]);
  });
});

describe("folder and tag together", () => {
  it("agreeing evidence is one row listing both", () => {
    const report = scan([...projectFolder(3), note("Projects/new.md", { tags: ["project"] })]);
    expect(report.proposals[0]?.evidence.map((e) => e.kind)).toEqual(["folder", "tag"]);
  });

  it("disagreeing evidence is no proposal and the note is pending for the model", () => {
    const report = scan([...projectFolder(3), note("Projects/new.md", { tags: ["person"] })]);
    expect(report.proposals).toEqual([]);
    expect(report.pending.map((p) => p.path)).toEqual(["Projects/new.md"]);
  });
});

describe("stored model verdicts", () => {
  const verdict = (over: Partial<StoredTypeVerdict> = {}): StoredTypeVerdict => ({ type: "person", model: "m1", at: "2026-10-07T10:00:00.000Z", mtime: 5, ...over });

  it("a valid verdict becomes a model row and is not pending", () => {
    const report = scan([note("a.md", { mtime: 5 })], { verdicts: { "a.md": verdict() } });
    expect(report.proposals[0]).toMatchObject({ path: "a.md", type: "person", evidence: [{ kind: "model", model: "m1" }] });
    expect(report.pending).toEqual([]);
  });

  it("a changed mtime makes the verdict stale and the note pending again", () => {
    const report = scan([note("a.md", { mtime: 6 })], { verdicts: { "a.md": verdict() } });
    expect(report.proposals).toEqual([]);
    expect(report.pending.map((p) => p.path)).toEqual(["a.md"]);
  });

  it("a verdict whose type left the registry or became non-proposable is stale", () => {
    for (const type of ["ghost", "claim", "entity"]) {
      const report = scan([note("a.md", { mtime: 5 })], { verdicts: { "a.md": verdict({ type }) } });
      expect(report.proposals).toEqual([]);
      expect(report.pending).toHaveLength(1);
    }
  });

  it("a null verdict gives no row and is not re-sent while the proposable list is unchanged", () => {
    const report = scan([note("a.md", { mtime: 5 })], { verdicts: { "a.md": verdict({ type: null, types: "concept,person,project" }) } });
    expect(report.proposals).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.noProposal).toBe(1);
  });

  it("a null verdict is stale once types were seeded, or when it recorded none", () => {
    for (const types of ["concept,person", "", undefined]) {
      const report = scan([note("a.md", { mtime: 5 })], { verdicts: { "a.md": verdict({ type: null, ...(types !== undefined ? { types } : {}) }) } });
      expect(report.pending.map((p) => p.path)).toEqual(["a.md"]);
    }
  });

  it("deterministic evidence wins over a stored verdict", () => {
    const report = scan([...projectFolder(3), note("Projects/n.md", { mtime: 5 })], { verdicts: { "Projects/n.md": verdict() } });
    expect(report.proposals[0]).toMatchObject({ type: "project", evidence: [{ kind: "folder" }] });
  });

  it("a verdict for a dismissed or excluded or typed note is never used", () => {
    const report = scan(
      [note("d.md", { mtime: 5 }), note("Ontology/o.md", { mtime: 5 }), { ...typed("t.md", "project"), mtime: 5 }],
      { dismissed: new Set(["d.md"]), verdicts: { "d.md": verdict(), "Ontology/o.md": verdict(), "t.md": verdict() } },
    );
    expect(report.proposals).toEqual([]);
    expect(report.pending).toEqual([]);
  });
});

describe("hidden types never become rows", () => {
  it("a stored verdict naming chat or entity is stale, not a row", () => {
    for (const type of ["chat", "entity"]) {
      const report = scan([note("a.md", { mtime: 5 })], { verdicts: { "a.md": { type, model: "m", at: "t", mtime: 5 } } });
      expect(report.proposals).toEqual([]);
      expect(report.pending.map((p) => p.path)).toEqual(["a.md"]);
    }
  });

  it("folder siblings typed chat produce no folder row", () => {
    const report = scan([typed("C/a.md", "chat"), typed("C/b.md", "chat"), typed("C/c.md", "chat"), note("C/new.md")]);
    expect(report.proposals).toEqual([]);
    expect(report.pending.map((p) => p.path)).toEqual(["C/new.md"]);
  });
});

describe("conformance against the seeded ontology", () => {
  const seeded = registryOf(SEED_TYPES);
  const frontmatter = { url: "https://example.com", title: "x" };

  it("a note with a url key proposed person starts unchecked and names 'url'; proposed source starts checked", () => {
    const report = scan(
      [note("p.md", { tags: ["person"], frontmatter }), note("s.md", { tags: ["source"], frontmatter })],
      { registry: seeded },
    );
    const by = Object.fromEntries(report.proposals.map((p) => [p.path, p]));
    expect(by["p.md"]?.checked).toBe(false);
    expect(conformanceLine(by["p.md"]?.issues ?? [])).toContain("'url'");
    expect(by["s.md"]).toMatchObject({ type: "source", checked: true, issues: [] });
  });
});

describe("pending order", () => {
  it("is newest mtime first, path as the tiebreak", () => {
    const report = scan([note("b.md", { mtime: 2 }), note("a.md", { mtime: 2 }), note("c.md", { mtime: 9 })]);
    expect(report.pending.map((p) => p.path)).toEqual(["c.md", "a.md", "b.md"]);
  });
});

describe("conformance and checked", () => {
  const strict = registryOf([
    entity,
    def("project", { properties: [{ key: "status", type: "string", required: true }] }),
    def("person"),
  ]);

  it("starts checked only when the type raises no issue", () => {
    const report = scan(
      [note("a.md", { tags: ["project"], frontmatter: { title: "x" } }), note("b.md", { tags: ["person"], frontmatter: { title: "x" } }), note("c.md", { tags: ["person"], frontmatter: { url: "u" } })],
      { registry: strict },
    );
    const by = Object.fromEntries(report.proposals.map((p) => [p.path, p]));
    expect(by["a.md"]).toMatchObject({ checked: false, issues: ["missing required property 'status'"] });
    expect(by["b.md"]).toMatchObject({ checked: true, issues: [] });
    expect(by["c.md"]).toMatchObject({ checked: false, issues: ["'url' is not declared on type 'person'"] });
  });

  it("check(type) recomputes issues for another type on the same frontmatter", () => {
    const report = scan([note("a.md", { tags: ["person"], frontmatter: { title: "x" } })], { registry: strict });
    const row = report.proposals[0];
    expect(row?.check("project")).toEqual(["missing required property 'status'"]);
    expect(row?.check("person")).toEqual([]);
  });

  it("conformanceLine lists at most 3 and counts the rest", () => {
    expect(conformanceLine([])).toBe("");
    expect(conformanceLine(["a"])).toBe("adds 1 issue: a");
    expect(conformanceLine(["a", "b", "c", "d", "e"])).toBe("adds 5 issues: a; b; c; +2 more");
  });
});

describe("review cap", () => {
  it("shows 100 rows, deterministic first, and counts the rest", () => {
    const notes: TypeScanNote[] = [...projectFolder(3)];
    for (let i = 0; i < 60; i++) notes.push(note(`Projects/n${i}.md`, { mtime: 100 + i }));
    for (let i = 0; i < 60; i++) notes.push(note(`Other/m${i}.md`, { mtime: 1000 + i }));
    const verdicts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Other/m${i}.md`, { type: "person", model: "m", at: "t", mtime: 1000 + i }]));
    const report = scan(notes, { verdicts });
    expect(report.proposals).toHaveLength(MAX_TYPE_ROWS);
    expect(report.notShown).toBe(20);
    expect(report.proposals.slice(0, 60).every((p) => p.evidence[0]?.kind === "folder")).toBe(true);
    expect(report.proposals.slice(60).every((p) => p.evidence[0]?.kind === "model")).toBe(true);
    expect(report.proposals[0]?.path).toBe("Projects/n59.md");
    expect(report.candidates).toBe(120);
    expect(report.noProposal).toBe(0);
  });
});

describe("pure type weave modules", () => {
  it("typeScan never imports obsidian", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/optimize/typeScan.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']obsidian["']/);
  });
});
