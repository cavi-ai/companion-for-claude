import { describe, expect, it, vi } from "vitest";
import { OptimizeController, type OptimizeDeps } from "../../src/optimize/controller";
import { LinkWeaveController, type LinkWeaveDeps } from "../../src/optimize/linkController";
import type { OptimizeState } from "../../src/optimize/state";
import { pairKey, type MergeCandidate } from "../../src/optimize/tagScan";
import { TypeWeaveController, type TypeWeaveDeps } from "../../src/optimize/typeController";
import { resolveTypes } from "../../src/ontology/schema";
import type { ResolvedType } from "../../src/ontology/types";
import type { TypeRegistry } from "../../src/optimize/typeScan";

const FULL: OptimizeState = {
  dismissed: ["x|y"],
  dismissedLinks: ["a.md\u0000b.md"],
  verdicts: { "a|b": { verdict: "keep", a: "a", b: "b", model: "m", at: "2026-10-01T00:00:00.000Z" } },
  typeVerdicts: { "old.md": { type: "person", model: "m", at: "2026-10-01T00:00:00.000Z", mtime: 1, types: "person,project" } },
  dismissedTypes: ["z.md"],
  lastBackgroundRun: "2026-10-05T00:00:00.000Z",
};

const tagPairId = pairKey("ml", "machine-learning");
const candidate: MergeCandidate = { id: tagPairId, from: "ml", to: "machine-learning", evidence: ["semantic"], score: 0.9, fromCount: 1, toCount: 2 };

function tagController(initial: OptimizeState) {
  let state = initial;
  const deps: OptimizeDeps = {
    tagEntries: () => [{ path: "n.md", tags: ["a", "b", "ml", "machine-learning"] }],
    noteVectors: async () => null,
    noteTags: () => null,
    rewriteNote: async () => ({ inlineApplied: 0, inlineSkipped: 0, changed: [] }),
    orderTagTriggers: () => [],
    writeRunNote: async () => "",
    getState: () => state,
    setState: async (next) => { state = next; },
    now: () => "2026-10-07T10:00:00.000Z",
    classifier: async () => ({
      local: true,
      label: "Ollama",
      model: "m1",
      complete: async <T,>(_req: unknown, parse: (raw: string) => T): Promise<T> => parse(JSON.stringify({ verdicts: [{ pair: 1, verdict: "keep" }] })),
    }),
  };
  const controller = new OptimizeController(deps);
  vi.spyOn(controller, "scan").mockResolvedValue({ totalTags: 4, singleUse: 0, dropped: 0, candidates: [candidate] });
  return { controller, get: () => state };
}

function linkController(initial: OptimizeState) {
  let state = initial;
  const deps = {
    getState: () => state,
    setState: async (next: OptimizeState) => { state = next; },
  } as unknown as LinkWeaveDeps;
  return { controller: new LinkWeaveController(deps), get: () => state };
}

const def = (name: string, extendsType?: string) => ({ name, version: 1, properties: [], relations: [], ...(extendsType ? { extendsType } : {}) });
const { resolved } = resolveTypes([def("entity"), def("person", "entity"), def("project", "entity")]);
const registry: TypeRegistry = { resolve: (n) => resolved.get(n), resolved: () => resolved as ReadonlyMap<string, ResolvedType> };

function typeController(initial: OptimizeState) {
  let state = initial;
  const deps: TypeWeaveDeps = {
    notes: () => [{ path: "a.md", mtime: 2, frontmatter: undefined, tags: [] }],
    registry: async () => registry,
    ontologyFolder: () => "Ontology",
    read: async () => "body",
    setNoteType: async () => ({ written: true }),
    writeRunNote: async () => "",
    getState: () => state,
    setState: async (next) => { state = next; },
    now: () => "2026-10-07T10:00:00.000Z",
    classifier: async () => ({
      local: true,
      label: "Ollama",
      model: "m1",
      complete: async <T,>(_req: unknown, parse: (raw: string) => T): Promise<T> => parse(JSON.stringify({ verdicts: [{ n: 1, type: "project" }] })),
    }),
  };
  return { controller: new TypeWeaveController(deps), get: () => state };
}

type Key = keyof OptimizeState;
const rows: Array<[string, (initial: OptimizeState) => Promise<OptimizeState>, Key]> = [
  ["OptimizeController.dismiss", async (s) => { const c = tagController(s); await c.controller.dismiss("p|q"); return c.get(); }, "dismissed"],
  ["OptimizeController.classify", async (s) => { const c = tagController(s); await c.controller.classify(); return c.get(); }, "verdicts"],
  ["LinkWeaveController.dismiss", async (s) => { const c = linkController(s); await c.controller.dismiss({ source: "s.md", target: "t.md" }); return c.get(); }, "dismissedLinks"],
  ["TypeWeaveController.dismiss", async (s) => { const c = typeController(s); await c.controller.dismiss("y.md"); return c.get(); }, "dismissedTypes"],
  ["TypeWeaveController.classify", async (s) => { const c = typeController(s); await c.controller.classify(); return c.get(); }, "typeVerdicts"],
];

describe("every OptimizeState writer keeps every other field", () => {
  it.each(rows)("%s", async (_name, run, changed) => {
    const after = await run(structuredClone(FULL));
    expect(after[changed]).not.toEqual(FULL[changed]);
    for (const key of Object.keys(FULL) as Key[]) {
      expect(after, key).toHaveProperty(key);
      if (key !== changed) expect(after[key], key).toEqual(FULL[key]);
    }
  });
});
