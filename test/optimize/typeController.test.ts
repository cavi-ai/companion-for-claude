import { describe, expect, it } from "vitest";
import { resolveTypes } from "../../src/ontology/schema";
import type { ResolvedType, TypeDef } from "../../src/ontology/types";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import { ClassifierStoppedError, type ClassifierHandle } from "../../src/optimize/classifierGlue";
import type { OptimizeState } from "../../src/optimize/state";
import { MAX_TYPE_BATCHES, TYPE_BATCH } from "../../src/optimize/typeClassify";
import {
  formatTypeApplyNotice,
  formatTypeClassifyNotice,
  formatTypeScanNotice,
  renderTypeRunNote,
  TypeWeaveController,
  type TypeClassifyResult,
  type TypeWeaveDeps,
} from "../../src/optimize/typeController";
import type { TypeRegistry, TypeScanNote } from "../../src/optimize/typeScan";

const def = (name: string, over: Partial<TypeDef> = {}): TypeDef => ({ name, version: 1, extendsType: "entity", properties: [], relations: [], ...over });
const { resolved } = resolveTypes([def("entity", { extendsType: undefined }), def("project", { properties: [{ key: "status", type: "string", required: false }] }), def("person"), def("claim")]);
const registry: TypeRegistry = { resolve: (n) => resolved.get(n), resolved: () => resolved as ReadonlyMap<string, ResolvedType> };

const note = (path: string, over: Partial<TypeScanNote> = {}): TypeScanNote => ({ path, mtime: 1, frontmatter: undefined, tags: [], ...over });

interface Ctx {
  controller: TypeWeaveController;
  getState(): OptimizeState;
  sent: string[];
  reads: string[];
  writes: Array<{ path: string; type: string }>;
  runNotes: string[];
  classifierCalls: Array<{ interactive: boolean }>;
}

function setup(
  notes: TypeScanNote[],
  opts: { replies?: Array<string | Error>; state?: OptimizeState; files?: Record<string, string>; over?: Partial<TypeWeaveDeps>; registry?: TypeRegistry | null } = {},
): Ctx {
  let state: OptimizeState = opts.state ?? { dismissed: [], verdicts: {} };
  const replies = [...(opts.replies ?? [])];
  const sent: string[] = [];
  const reads: string[] = [];
  const writes: Ctx["writes"] = [];
  const runNotes: string[] = [];
  const classifierCalls: Ctx["classifierCalls"] = [];
  const handle: ClassifierHandle = {
    local: true,
    label: "Ollama",
    model: "m1",
    complete: async <T,>(req: { user: string }, parse: (raw: string) => T): Promise<T> => {
      sent.push(req.user);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return parse(next ?? '{"verdicts":[]}');
    },
  };
  const typed = new Set<string>();
  const deps: TypeWeaveDeps = {
    notes: () => notes,
    registry: async () => (opts.registry === undefined ? registry : opts.registry),
    ontologyFolder: () => "Ontology",
    read: async (path) => {
      reads.push(path);
      return opts.files?.[path] ?? `Body of ${path}`;
    },
    setNoteType: async (path, type) => {
      if (path === "gone.md") throw new Error("Note not found: gone.md");
      if (path === "typed.md" || typed.has(path)) return { written: false };
      typed.add(path);
      writes.push({ path, type });
      return { written: true };
    },
    writeRunNote: async (content) => {
      runNotes.push(content);
      return "Claude/Optimize/Type weave.md";
    },
    getState: () => state,
    setState: async (next) => {
      state = next;
    },
    now: () => "2026-10-07T10:00:00.000Z",
    classifier: async (o) => {
      classifierCalls.push(o);
      return handle;
    },
    ...opts.over,
  };
  return { controller: new TypeWeaveController(deps), getState: () => state, sent, reads, writes, runNotes, classifierCalls };
}

const reply = (...verdicts: Array<{ n: number; type: string | null }>): string => JSON.stringify({ verdicts });

describe("scan", () => {
  it("loads the registry through the dep and applies stored dismissals and verdicts", async () => {
    const ctx = setup([note("a.md", { mtime: 5 }), note("b.md"), note("c.md")], {
      state: {
        dismissed: [],
        verdicts: {},
        dismissedTypes: ["c.md"],
        typeVerdicts: { "a.md": { type: "person", model: "m", at: "t", mtime: 5 } },
      },
    });
    const report = await ctx.controller.scan();
    expect(report.proposals.map((p) => [p.path, p.type])).toEqual([["a.md", "person"]]);
    expect(report.pending.map((p) => p.path)).toEqual(["b.md"]);
  });

  it("reports no registry when the ontology is off", async () => {
    const ctx = setup([note("a.md")], { registry: null });
    expect((await ctx.controller.scan()).status).toBe("no-registry");
  });

  it("scanning never builds a classifier or reads a note", async () => {
    const ctx = setup([note("a.md")]);
    await ctx.controller.scan();
    expect(ctx.classifierCalls).toEqual([]);
    expect(ctx.reads).toEqual([]);
    expect(ctx.sent).toEqual([]);
  });
});

describe("classify", () => {
  it("sends only title, folder, tags, headings and excerpt for untyped notes, plus the type list", async () => {
    const ctx = setup(
      [
        note("Projects/Café 🧠.md", { tags: ["#idea"], mtime: 9 }),
        note("typed.md", { frontmatter: { type: "project" } }),
        note("Dismissed.md"),
        note("Ontology/schema.md"),
        note("Claude/Optimize/run.md"),
      ],
      {
        state: { dismissed: [], verdicts: {}, dismissedTypes: ["Dismissed.md"] },
        files: { "Projects/Café 🧠.md": "---\nsecret: k\n---\n# Head\nProse here\n```\ncode\n```" },
        replies: [reply({ n: 1, type: "project" })],
      },
    );
    await ctx.controller.classify();
    expect(ctx.reads).toEqual(["Projects/Café 🧠.md"]);
    expect(ctx.sent).toEqual([
      [
        "Types:",
        '- "person"',
        '- "project": properties: status',
        "",
        "Notes:",
        '1. {"title":"Café 🧠","folder":"Projects","tags":["idea"],"headings":["Head"],"excerpt":"# Head Prose here"}',
      ].join("\n"),
    ]);
    expect(ctx.sent[0]).not.toContain("secret");
    expect(ctx.sent[0]).not.toContain("code");
    expect(ctx.sent[0]).not.toContain("claim");
  });

  it("is always interactive and stores verdicts with model, time and the scan mtime", async () => {
    const ctx = setup([note("a.md", { mtime: 7 }), note("b.md", { mtime: 3 })], { replies: [reply({ n: 1, type: "person" }, { n: 2, type: null })] });
    const result = await ctx.controller.classify();
    expect(ctx.classifierCalls).toEqual([{ interactive: true }]);
    expect(result).toEqual({ judged: 2, typed: 1, none: 1, failedBatches: 0, notChecked: 0 });
    expect(ctx.getState().typeVerdicts).toEqual({
      "a.md": { type: "person", model: "m1", at: "2026-10-07T10:00:00.000Z", mtime: 7, types: "person,project" },
      "b.md": { type: null, model: "m1", at: "2026-10-07T10:00:00.000Z", mtime: 3, types: "person,project" },
    });
  });

  it("a verdict is attached to the note the reply numbered, newest first", async () => {
    const ctx = setup([note("old.md", { mtime: 1 }), note("new.md", { mtime: 9 })], { replies: [reply({ n: 1, type: "project" })] });
    await ctx.controller.classify();
    expect(Object.keys(ctx.getState().typeVerdicts ?? {})).toEqual(["new.md"]);
  });

  it("skips notes with deterministic evidence and valid stored verdicts", async () => {
    const notes = [
      note("a.md", { tags: ["project"] }),
      note("b.md", { mtime: 4 }),
      note("c.md", { mtime: 6 }),
    ];
    const ctx = setup(notes, { state: { dismissed: [], verdicts: {}, typeVerdicts: { "b.md": { type: null, model: "m", at: "t", mtime: 4, types: "person,project" } } }, replies: [reply({ n: 1, type: "person" })] });
    await ctx.controller.classify();
    expect(ctx.reads).toEqual(["c.md"]);
  });

  it("makes no call and reads nothing when there is nothing to check", async () => {
    const ctx = setup([note("typed.md", { frontmatter: { type: "project" } })]);
    const result = await ctx.controller.classify();
    expect(ctx.sent).toEqual([]);
    expect(ctx.reads).toEqual([]);
    expect(result.judged).toBe(0);
  });

  it("an empty registry sends nothing", async () => {
    const ctx = setup([note("a.md")], { registry: { resolve: () => undefined, resolved: () => new Map() } });
    await ctx.controller.classify();
    expect(ctx.sent).toEqual([]);
    expect(ctx.reads).toEqual([]);
  });

  it("sends 20 per call, at most 10 calls, and counts the rest as not checked", async () => {
    const notes = Array.from({ length: 230 }, (_, i) => note(`n${i}.md`, { mtime: 1000 - i }));
    const ctx = setup(notes);
    const result = await ctx.controller.classify();
    expect(TYPE_BATCH).toBe(20);
    expect(MAX_TYPE_BATCHES).toBe(10);
    expect(ctx.sent).toHaveLength(10);
    expect(ctx.reads).toHaveLength(200);
    expect(result.notChecked).toBe(30);
    expect(ctx.reads[0]).toBe("n0.md");
  });

  it("a second call while one runs joins it and sends once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const ctx = setup([note("a.md")], { over: { read: async () => { await gate; return "x"; } }, replies: [reply({ n: 1, type: "person" })] });
    const first = ctx.controller.classify();
    const second = ctx.controller.classify();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.classifierCalls).toHaveLength(1);
  });

  it("allows a new run after one finished", async () => {
    const ctx = setup([note("a.md")]);
    await ctx.controller.classify();
    await ctx.controller.classify();
    expect(ctx.classifierCalls).toHaveLength(1 + 1);
  });

  it("an aborted signal sends no second batch and keeps the verdicts already stored", async () => {
    const control = new AbortController();
    const notes = Array.from({ length: 25 }, (_, i) => note(`n${i}.md`, { mtime: 100 - i }));
    let calls = 0;
    let state: OptimizeState = { dismissed: [], verdicts: {} };
    const controller = new TypeWeaveController({
      notes: () => notes,
      registry: async () => registry,
      ontologyFolder: () => "Ontology",
      read: async () => "x",
      setNoteType: async () => ({ written: true }),
      writeRunNote: async () => "",
      getState: () => state,
      setState: async (next) => { state = next; },
      now: () => "t",
      classifier: async () => ({
        local: true,
        label: "l",
        model: "m",
        complete: async <T,>(_req: unknown, parse: (raw: string) => T): Promise<T> => {
          calls++;
          control.abort();
          return parse(reply({ n: 1, type: "person" }));
        },
      }),
    });
    await controller.classify({ signal: control.signal });
    expect(calls).toBe(1);
    expect(Object.keys(state.typeVerdicts ?? {})).toEqual(["n0.md"]);
  });

  it("a ClassifierStoppedError writes no state and rethrows", async () => {
    let writes = 0;
    const ctx = setup([note("a.md")], { replies: [new ClassifierStoppedError("unloaded")], over: { setState: async () => { writes++; } } });
    await expect(ctx.controller.classify()).rejects.toBeInstanceOf(ClassifierStoppedError);
    expect(writes).toBe(0);
  });

  it("a later batch failure still stores the earlier verdicts and then throws", async () => {
    const notes = Array.from({ length: 25 }, (_, i) => note(`n${i}.md`, { mtime: 100 - i }));
    const ctx = setup(notes, { replies: [reply({ n: 1, type: "person" }), new Error("boom")] });
    await expect(ctx.controller.classify()).rejects.toThrow("boom");
    expect(Object.keys(ctx.getState().typeVerdicts ?? {})).toEqual(["n0.md"]);
  });

  it("an unparseable batch counts as failed, stores nothing for it, and the run continues", async () => {
    const notes = Array.from({ length: 25 }, (_, i) => note(`n${i}.md`, { mtime: 100 - i }));
    const ctx = setup(notes, { replies: ["nope", reply({ n: 1, type: "person" })] });
    const result = await ctx.controller.classify();
    expect(result).toMatchObject({ failedBatches: 1, judged: 1 });
    expect(Object.keys(ctx.getState().typeVerdicts ?? {})).toEqual(["n20.md"]);
  });

  it("drops entries naming a type outside the proposable list and leaves those notes unchecked", async () => {
    const ctx = setup([note("a.md", { mtime: 3 }), note("b.md", { mtime: 2 }), note("c.md", { mtime: 1 })], {
      replies: [reply({ n: 1, type: "claim" }, { n: 2, type: "entity" }, { n: 3, type: "Person" })],
    });
    const result = await ctx.controller.classify();
    expect(result.judged).toBe(0);
    expect(ctx.getState().typeVerdicts).toBeUndefined();
  });

  it("a note typed before the check is not read or sent", async () => {
    const live = [note("a.md"), note("b.md", { mtime: 0 })];
    const ctx = setup(live, { replies: [reply({ n: 1, type: "person" })] });
    live[0] = note("a.md", { frontmatter: { type: "project" } });
    await ctx.controller.classify();
    expect(ctx.reads).toEqual(["b.md"]);
  });

  it("skips a note whose read fails", async () => {
    const ctx = setup([note("a.md", { mtime: 2 }), note("b.md", { mtime: 1 })], {
      replies: [reply({ n: 1, type: "person" })],
      over: { read: async (p) => { if (p === "a.md") throw new Error("gone"); return "x"; } },
    });
    await ctx.controller.classify();
    expect(Object.keys(ctx.getState().typeVerdicts ?? {})).toEqual(["b.md"]);
  });

  it("with nothing pending, never builds the classifier", async () => {
    const none = setup([note("typed.md", { frontmatter: { type: "project" } }), note("v.md", { mtime: 3 })], {
      state: { dismissed: [], verdicts: {}, typeVerdicts: { "v.md": { type: null, model: "m", at: "t", mtime: 3, types: "person,project" } } },
    });
    await none.controller.classify();
    expect(none.classifierCalls).toEqual([]);
    const off = setup([note("a.md")], { registry: null });
    await off.controller.classify();
    expect(off.classifierCalls).toEqual([]);
  });

  it("a note typed while batch 1 is at the model is never read or sent in batch 2", async () => {
    const notes = Array.from({ length: 21 }, (_, i) => note(`n${i}.md`, { mtime: 100 - i }));
    let calls = 0;
    const ctx = setup(notes, { over: { notes: () => (calls++ === 0 ? notes : notes.map((n) => (n.path === "n20.md" ? { ...n, frontmatter: { type: "project" } } : n))) } });
    await ctx.controller.classify();
    expect(ctx.reads).not.toContain("n20.md");
    expect(ctx.sent.join("\n")).not.toContain("n20");
  });

  it("a note dismissed while batch 1 is at the model is not read in batch 2", async () => {
    const notes = Array.from({ length: 21 }, (_, i) => note(`n${i}.md`, { mtime: 100 - i }));
    let state: OptimizeState = { dismissed: [], verdicts: {} };
    const ctx = setup(notes, { over: { getState: () => state, setState: async (next) => { state = next; }, read: async (p) => { if (p === "n0.md") state = { ...state, dismissedTypes: ["n20.md"] }; return "x"; } } });
    await ctx.controller.classify();
    expect(ctx.sent).toHaveLength(1);
  });

  it("stores the live mtime from the read, not the scan's", async () => {
    let mtime = 5;
    const ctx = setup([], { replies: [reply({ n: 1, type: "person" })], over: { notes: () => [note("a.md", { mtime: mtime++ })] } });
    await ctx.controller.classify();
    expect(ctx.getState().typeVerdicts?.["a.md"]?.mtime).toBe(6);
  });

  it("a run aborted by one caller and joined by a fresh one finishes for the fresh caller", async () => {
    const notes = Array.from({ length: 45 }, (_, i) => note(`n${i}.md`, { mtime: 100 - i }));
    const first = new AbortController();
    let second: Promise<TypeClassifyResult> | undefined;
    let calls = 0;
    let state: OptimizeState = { dismissed: [], verdicts: {} };
    const controller = new TypeWeaveController({
      notes: () => notes,
      registry: async () => registry,
      ontologyFolder: () => "Ontology",
      read: async () => "x",
      setNoteType: async () => ({ written: true }),
      writeRunNote: async () => "",
      getState: () => state,
      setState: async (next) => { state = next; },
      now: () => "t",
      classifier: async () => ({
        local: true,
        label: "l",
        model: "m",
        complete: async <T,>(_req: unknown, parse: (raw: string) => T): Promise<T> => {
          calls++;
          if (calls === 1) {
            first.abort();
            second = controller.classify();
          }
          return parse(reply({ n: 1, type: "person" }));
        },
      }),
    });
    const a = await controller.classify({ signal: first.signal });
    const b = await second;
    expect(a.judged).toBe(1);
    expect(calls).toBe(4);
    expect(b?.judged).toBe(3);
    expect(Object.keys(state.typeVerdicts ?? {})).toHaveLength(4);
  });

  it("sanitizes title, folder, tags, headings and excerpt before they enter the request", async () => {
    const key = "sk-ant-abcdefghij1234567890";
    const ctx = setup([note(`${key}/${key}.md`, { tags: [`#${key}`] })], {
      files: { [`${key}/${key}.md`]: `# Heading ${key}\nExcerpt text ${key} end` },
      replies: [reply({ n: 1, type: "person" })],
    });
    await ctx.controller.classify();
    expect(ctx.sent[0]).toContain("‹REDACTED›");
    expect(ctx.sent[0]).not.toContain("sk-ant");
    const parsed = JSON.parse((ctx.sent[0] as string).split("\n").pop()!.replace(/^1\. /, "")) as { headings: string[]; excerpt: string };
    expect(parsed.headings[0]).toContain("‹REDACTED›");
    expect(parsed.excerpt).toContain("‹REDACTED›");
  });

  it("propagates an unavailable utility before reading any note", async () => {
    const error = new UtilityUnavailableError("no", { state: "unavailable-loopback", backend: "ollama", endpoint: "http://localhost:11434" });
    const ctx = setup([note("a.md")], { over: { classifier: async () => { throw error; } } });
    await expect(ctx.controller.classify()).rejects.toBe(error);
    expect(ctx.reads).toEqual([]);
  });
});

describe("classifierInfo", () => {
  it("returns label and model, needsConfirmation for unavailable-loopback, and rethrows anything else", async () => {
    expect(await setup([]).controller.classifierInfo()).toEqual({ label: "Ollama", model: "m1" });
    const loop = new UtilityUnavailableError("x", { state: "unavailable-loopback", backend: "ollama", endpoint: "http://localhost:11434" });
    expect(await setup([], { over: { classifier: async () => { throw loop; } } }).controller.classifierInfo()).toEqual({ needsConfirmation: true });
    await expect(setup([], { over: { classifier: async () => { throw new Error("other"); } } }).controller.classifierInfo()).rejects.toThrow("other");
  });

  it("builds the classifier non-interactively and sends nothing", async () => {
    const ctx = setup([note("a.md")]);
    await ctx.controller.classifierInfo();
    expect(ctx.classifierCalls).toEqual([{ interactive: false }]);
    expect(ctx.sent).toEqual([]);
    expect(ctx.reads).toEqual([]);
  });
});

describe("apply", () => {
  it("writes exactly the rows it is given, once per path, and reports typed, skipped and failed", async () => {
    const ctx = setup([]);
    const result = await ctx.controller.apply([
      { path: "a.md", type: "project" },
      { path: "a.md", type: "person" },
      { path: "typed.md", type: "person" },
      { path: "gone.md", type: "person" },
      { path: "Café 🧠.md", type: "person" },
    ]);
    expect(ctx.writes).toEqual([{ path: "a.md", type: "project" }, { path: "Café 🧠.md", type: "person" }]);
    expect(result).toMatchObject({ typed: 2, skipped: ["typed.md"], failed: [{ path: "gone.md", message: "Note not found: gone.md" }], runNote: "Claude/Optimize/Type weave.md" });
  });

  it("refuses a type that is not proposable now and writes nothing for it", async () => {
    const ctx = setup([]);
    const result = await ctx.controller.apply([
      { path: "a.md", type: "entity" },
      { path: "b.md", type: "claim" },
      { path: "c.md", type: "ghost" },
      { path: "d.md", type: "Project" },
    ]);
    expect(ctx.writes).toEqual([]);
    expect(result.typed).toBe(0);
    expect(result.failed).toHaveLength(4);
    expect(result.runNote).toBeNull();
    expect(ctx.runNotes).toEqual([]);
  });

  it("refuses an excluded path", async () => {
    const ctx = setup([]);
    const result = await ctx.controller.apply([{ path: "Ontology/x.md", type: "project" }, { path: "Claude/Optimize/r.md", type: "project" }]);
    expect(ctx.writes).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });

  it("writes no run note when nothing was typed and survives a run-note failure", async () => {
    const none = setup([]);
    expect((await none.controller.apply([{ path: "typed.md", type: "project" }])).runNote).toBeNull();
    const broken = setup([], { over: { writeRunNote: async () => { throw new Error("disk"); } } });
    expect(await broken.controller.apply([{ path: "a.md", type: "project" }])).toMatchObject({ typed: 1, runNote: null });
  });

  it("the run note lists paths and types in code spans and never a wikilink", async () => {
    const ctx = setup([]);
    await ctx.controller.apply([{ path: "[[x]]/Café 🧠 2024.md", type: "project" }, { path: "typed.md", type: "person" }]);
    const note = ctx.runNotes[0] as string;
    expect(note).not.toContain("[[");
    expect(note).toContain('type: "optimize-run"');
    expect(note).toContain("# Type weave");
    expect(note).toContain("- `x/Café 🧠 2024.md` → `project`");
    expect(note).toContain("- `typed.md`");
  });
});

describe("state writes keep every field", () => {
  const full: OptimizeState = {
    dismissed: ["t|u"],
    verdicts: { "a|b": { verdict: "keep", a: "a", b: "b", model: "m", at: "t" } },
    dismissedLinks: ["a.md\u0000b.md"],
    typeVerdicts: { "old.md": { type: "person", model: "m", at: "2026-10-01T00:00:00.000Z", mtime: 1 } },
    dismissedTypes: ["x.md"],
    lastBackgroundRun: "2026-10-05T00:00:00.000Z",
  };

  it("dismiss appends the path and drops no other field", async () => {
    const ctx = setup([], { state: full });
    await ctx.controller.dismiss("y.md");
    expect(ctx.getState()).toEqual({ ...full, dismissedTypes: ["x.md", "y.md"] });
  });

  it("classify merges new verdicts into the stored ones and drops no other field", async () => {
    const ctx = setup([note("a.md", { mtime: 2 })], { state: full, replies: [reply({ n: 1, type: "project" })] });
    await ctx.controller.classify();
    expect(ctx.getState()).toEqual({
      ...full,
      typeVerdicts: { ...full.typeVerdicts, "a.md": { type: "project", model: "m1", at: "2026-10-07T10:00:00.000Z", mtime: 2, types: "person,project" } },
    });
  });

  it("classify reads the state at write time, so a dismissal made during the check survives", async () => {
    let state: OptimizeState = full;
    const ctx = setup([note("a.md", { mtime: 2 })], {
      state: full,
      replies: [reply({ n: 1, type: "project" })],
      over: {
        getState: () => state,
        setState: async (next) => { state = next; },
        read: async () => {
          state = { ...state, dismissedTypes: [...(state.dismissedTypes ?? []), "late.md"] };
          return "x";
        },
      },
    });
    await ctx.controller.classify();
    expect(state.dismissedTypes).toEqual(["x.md", "late.md"]);
  });

  it("apply writes no state", async () => {
    let writes = 0;
    const ctx = setup([], { state: full, over: { setState: async () => { writes++; } } });
    await ctx.controller.apply([{ path: "a.md", type: "project" }]);
    expect(writes).toBe(0);
  });
});

describe("notices", () => {
  it("scan notices cover the three empty cases and nothing otherwise", () => {
    expect(formatTypeScanNotice({ status: "no-registry", candidates: 0 })).toBe("Turn on the ontology in Settings to type notes.");
    expect(formatTypeScanNotice({ status: "no-types", candidates: 0 })).toBe("Seed the ontology first (command: Seed ontology).");
    expect(formatTypeScanNotice({ status: "ok", candidates: 0 })).toBe("Every note has a type.");
    expect(formatTypeScanNotice({ status: "ok", candidates: 3 })).toBeNull();
  });

  it("apply and classify notices", () => {
    expect(formatTypeApplyNotice({ typed: 1, skipped: [], failed: [], runNote: null })).toBe("Typed 1 note");
    expect(formatTypeApplyNotice({ typed: 2, skipped: ["a"], failed: [{ path: "b", message: "m" }], runNote: null })).toBe("Typed 2 notes, 1 note typed since the review and left alone, 1 note failed");
    expect(formatTypeClassifyNotice({ judged: 3, typed: 2, none: 1, failedBatches: 1, notChecked: 5 })).toBe("Model checked 3 notes: 2 typed, 1 no fitting type, 1 batch failed, 5 not checked (limit)");
  });

  it("renderTypeRunNote lists skipped and failed sections", () => {
    const text = renderTypeRunNote({ applied: [], skipped: ["s.md"], failed: [{ path: "f.md", message: "bad [[x]]" }] }, "2026-10-07T10:00:00.000Z");
    expect(text).toContain("## Typed since the review, not edited");
    expect(text).toContain("- `f.md` — bad x");
  });
});
