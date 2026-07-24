import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { OntologyRegistry, type OntologyIO } from "../../src/ontology/registry";
import { schemaNoteContent, SEED_TYPES } from "../../src/ontology/seed";

function ioFromNotes(notes: Array<{ path: string; content: string }>): OntologyIO {
  return {
    listSchemaNotes: () => Promise.resolve(notes.map((n) => {
      const m = n.content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return m
        ? { path: n.path, frontmatter: parseYaml(m[1] ?? "") as Record<string, unknown>, body: m[2] ?? "" }
        : { path: n.path, body: n.content };
    })),
    parseYaml,
  };
}

const seededNotes = SEED_TYPES.map((d) => ({ path: `Ontology/${d.name}.md`, content: schemaNoteContent(d) }));

describe("OntologyRegistry", () => {
  it("loads seeded notes and resolves types", async () => {
    const reg = new OntologyRegistry(ioFromNotes(seededNotes));
    const { errors } = await reg.load();
    expect(errors).toEqual([]);
    expect(reg.resolve("person")?.lineage).toEqual(["person", "entity"]);
    expect(reg.digest()).toContain("- person");
  });
  it("is empty before load", () => {
    const reg = new OntologyRegistry(ioFromNotes([]));
    expect(reg.resolve("person")).toBeUndefined();
    expect(reg.digest()).toBe("");
  });
  it("skips broken notes with errors, loads the rest", async () => {
    const broken = { path: "Ontology/bad.md", content: "---\nontology: type\n---\nno name" };
    const reg = new OntologyRegistry(ioFromNotes([...seededNotes, broken]));
    const { errors } = await reg.load();
    expect(errors.some((e) => e.path === "Ontology/bad.md")).toBe(true);
    expect(reg.resolve("person")).toBeDefined();
  });
  it("registers a partially-valid type and surfaces its entry errors", async () => {
    const partial = {
      path: "Ontology/gadget.md",
      content: "---\nontology: type\ntype_name: gadget\n---\n```yaml\nextends: entity\nproperties:\n  - key: good\n    type: string\n  - key: bad\n    type: blob\n```",
    };
    const reg = new OntologyRegistry(ioFromNotes([...seededNotes, partial]));
    const { errors } = await reg.load();
    expect(errors.some((e) => e.path === "Ontology/gadget.md")).toBe(true);
    expect(reg.resolve("gadget")?.properties.map((p) => p.key)).toContain("good");
  });
  it("keeps the last-good schema when a reload's IO throws", async () => {
    let fail = false;
    const base = ioFromNotes(seededNotes);
    const io: OntologyIO = { parseYaml, listSchemaNotes: () => (fail ? Promise.reject(new Error("io")) : base.listSchemaNotes()) };
    const reg = new OntologyRegistry(io);
    await reg.load();
    fail = true;
    const { errors } = await reg.load();
    expect(errors.some((e) => /io/.test(e.message))).toBe(true);
    expect(reg.resolve("person")).toBeDefined(); // last-good retained
  });
  it("ignores non-schema notes in the folder", async () => {
    const readme = { path: "Ontology/README.md", content: "just docs, no frontmatter" };
    const reg = new OntologyRegistry(ioFromNotes([...seededNotes, readme]));
    const { errors } = await reg.load();
    expect(errors).toEqual([]); // silently skipped — not an error
  });
  it("a stale overlapping load does not clobber a newer one", async () => {
    type Notes = Awaited<ReturnType<OntologyIO["listSchemaNotes"]>>;
    let resolveSlow!: (notes: Notes) => void;
    const slow = new Promise<Notes>((res) => { resolveSlow = res; });
    let call = 0;
    const base = ioFromNotes(seededNotes);
    const io: OntologyIO = { parseYaml, listSchemaNotes: () => (++call === 1 ? slow : base.listSchemaNotes()) };
    const reg = new OntologyRegistry(io);
    const slowLoad = reg.load(); // older load, listing still pending
    await reg.load(); // newer load completes with the seeded types
    resolveSlow([]); // the stale load finally resolves with an empty vault
    await slowLoad;
    expect(reg.resolve("person")).toBeDefined(); // newer load owns the state
    expect(reg.digest()).toContain("- person");
  });
  it("a successful load of an empty list clears a previously populated schema", async () => {
    const notes = [...seededNotes];
    const io: OntologyIO = { parseYaml, listSchemaNotes: () => ioFromNotes(notes).listSchemaNotes() };
    const reg = new OntologyRegistry(io);
    await reg.load();
    expect(reg.resolve("person")).toBeDefined();
    notes.length = 0; // vault emptied — a successful load, not a failure
    const { errors } = await reg.load();
    expect(errors).toEqual([]);
    expect(reg.resolve("person")).toBeUndefined();
    expect(reg.digest()).toBe("");
  });
  it("a successful reload after an IO failure clears the error and repopulates", async () => {
    let fail = true;
    const base = ioFromNotes(seededNotes);
    const io: OntologyIO = { parseYaml, listSchemaNotes: () => (fail ? Promise.reject(new Error("io")) : base.listSchemaNotes()) };
    const reg = new OntologyRegistry(io);
    const first = await reg.load();
    expect(first.errors.some((e) => /io/.test(e.message))).toBe(true);
    fail = false;
    const { errors } = await reg.load();
    expect(errors).toEqual([]);
    expect(reg.errors()).toEqual([]);
    expect(reg.resolve("person")).toBeDefined();
  });
});
