import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { collapseMerges, planTagMerges } from "../../src/optimize/mergePlan";
import { acceptsRelated, addRelatedLinks, applyNoteMerge, linkScanNotes, noteTagInput, processNoteBody, writeOptimizeRunNote } from "../../src/optimize/vaultGlue";
import { SEED_TYPES } from "../../src/ontology/seed";
import { resolveTypes } from "../../src/ontology/schema";
import type { ResolvedType } from "../../src/ontology/types";

function seeded(content: string, fmTags: unknown) {
  const app = new App();
  const inline: Array<{ tag: string; start: number; end: number }> = [];
  for (const m of content.matchAll(/#([A-Za-z0-9_/-]+)/g)) inline.push({ tag: m[1] as string, start: m.index as number, end: (m.index as number) + m[0].length });
  const file = app.vault.seed("N.md", content, { frontmatter: { tags: fmTags }, inlineTags: inline });
  return { app: app as never as import("obsidian").App, file };
}

const read = async (app: App, path: string) => (app.vault.getAbstractFileByPath(path) as unknown as { _content: string })._content;

describe("noteTagInput", () => {
  it("reads tags and tag (array or comma/space string) plus inline positions", () => {
    const content = "---\ntags:\n  - llms\n---\nbody #LLMs end\n";
    const { app } = seeded(content, ["llms"]);
    const input = noteTagInput(app, "N.md");
    expect(input?.frontmatterTags).toEqual(["llms"]);
    expect(input?.inline).toEqual([{ tag: "LLMs", start: content.indexOf("#LLMs"), end: content.indexOf("#LLMs") + 5 }]);
    const str = seeded("x", "a, b c");
    expect(noteTagInput(str.app, "N.md")?.frontmatterTags).toEqual(["a", "b", "c"]);
  });

  it("returns null for a missing note", () => {
    expect(noteTagInput(new App() as never, "nope.md")).toBeNull();
  });
});

describe("applyNoteMerge", () => {
  it("merges [llms, llm] to one llm, rewrites #LLMs inline, leaves #ai/agents", async () => {
    const content = "---\ntags:\n  - llms\n  - llm\n  - Keep_Me\n---\nabout #LLMs and #ai/agents\n";
    const { app } = seeded(content, ["llms", "llm", "Keep_Me"]);
    const { map } = collapseMerges([{ from: "llms", to: "llm" }, { from: "ai", to: "artificial-intelligence" }]);
    const [plan] = planTagMerges(map, [noteTagInput(app, "N.md")!]);
    const result = await applyNoteMerge(app, plan!, map);
    expect(result).toEqual({ inlineApplied: 1, inlineSkipped: 0, changed: expect.arrayContaining(["llms"]) });
    const out = await read(app as never, "N.md");
    expect(out).toContain("  - \"llm\"\n  - \"Keep_Me\"");
    expect(out.match(/- "llm"/g)).toHaveLength(1);
    expect(out).not.toContain("llms");
    expect(out).toContain("#llm and #ai/agents");
  });

  it("skips and counts an inline occurrence that moved since the cache was read", async () => {
    const content = "---\ntags:\n  - x\n---\nlead #llms\n";
    const { app } = seeded(content, ["x"]);
    const map = new Map([["llms", "llm"]]);
    const input = noteTagInput(app, "N.md")!;
    const file = app.vault.getAbstractFileByPath("N.md") as unknown as { _content: string };
    file._content = `PADDING ${file._content}`;
    const [plan] = planTagMerges(map, [input]);
    expect(await applyNoteMerge(app, plan!, map)).toEqual({ inlineApplied: 0, inlineSkipped: 1, changed: [] });
    expect(file._content).toContain("#llms");
  });

  it("writes a tag key back only when it changed, keeping a string value a string", async () => {
    const { app } = seeded("---\ntag: llms other\nstatus: open\n---\nbody\n", undefined);
    (app.vault as never as { frontmatters: Map<string, unknown> }).frontmatters.set("N.md", { tag: "llms other" });
    const map = new Map([["llms", "llm"]]);
    const [plan] = planTagMerges(map, [noteTagInput(app, "N.md")!]);
    await applyNoteMerge(app, plan!, map);
    const out = await read(app as never, "N.md");
    expect(out).toContain("tag: \"llm, other\"");
    expect(out).toContain("status: \"open\"");
    expect(out).not.toContain("tags:");
  });
});

describe("applyNoteMerge by vault spelling", () => {
  it("rewrites a capitalized Tags key", async () => {
    const { app } = seeded("---\nTags:\n  - llms\n---\nbody\n", undefined);
    (app.vault as never as { frontmatters: Map<string, unknown> }).frontmatters.set("N.md", { Tags: ["llms"] });
    const map = new Map([["llms", "llm"]]);
    const [plan] = planTagMerges(map, [noteTagInput(app, "N.md")!]);
    await applyNoteMerge(app, plan!, map);
    const out = await read(app as never, "N.md");
    expect(out).toContain("Tags:");
    expect(out).toContain("\"llm\"");
    expect(out).not.toContain("llms");
  });

  it("keeps null and numeric list entries untouched", async () => {
    const { app } = seeded("body\n", undefined);
    const fm: Record<string, unknown> = { tags: ["llms", null, 2024] };
    (app.vault as never as { frontmatters: Map<string, unknown> }).frontmatters.set("N.md", fm);
    (app.fileManager as never as { processFrontMatter: unknown }).processFrontMatter = async (_f: unknown, fn: (o: Record<string, unknown>) => void) => fn(fm);
    const map = new Map([["llms", "llm"]]);
    const [plan] = planTagMerges(map, [noteTagInput(app, "N.md")!]);
    await applyNoteMerge(app, plan!, map);
    expect(fm.tags).toEqual(["llm", null, 2024]);
  });

  it("rewrites an inline emoji tag by its own spelling", async () => {
    const content = "see #📚books here\n";
    const { app } = seeded(content, undefined);
    (app.vault as never as { inlineTags: Map<string, unknown> }).inlineTags.set("N.md", [{ tag: "📚books", start: 4, end: 4 + "#📚books".length }]);
    const map = new Map([["📚books", "📚book"]]);
    const [plan] = planTagMerges(map, [noteTagInput(app, "N.md")!]);
    await applyNoteMerge(app, plan!, map);
    expect(await read(app as never, "N.md")).toBe("see #📚book here\n");
  });
});

describe("applyNoteMerge inline-only", () => {
  it("leaves the frontmatter block byte-identical", async () => {
    const content = "---\ntags:\n  - x\nstatus:   open\n---\nsee #llms\n";
    const { app } = seeded(content, ["x"]);
    const map = new Map([["llms", "llm"]]);
    const [plan] = planTagMerges(map, [noteTagInput(app, "N.md")!]);
    await applyNoteMerge(app, plan!, map);
    const out = await read(app as never, "N.md");
    expect(out).toBe("---\ntags:\n  - x\nstatus:   open\n---\nsee #llm\n");
  });
});

describe("applyNoteMerge failures", () => {
  it("throws for a note that no longer exists", async () => {
    const { app } = seeded("x", ["x"]);
    const plan = { path: "gone.md", before: [], after: [], inline: [] };
    await expect(applyNoteMerge(app, plan, new Map())).rejects.toThrow();
  });
});

describe("writeOptimizeRunNote", () => {
  it("creates the note under Claude/Optimize and never overwrites", async () => {
    const app = new App() as never as import("obsidian").App;
    const first = await writeOptimizeRunNote(app, "one", "2026-10-05T10:00:00.000Z");
    const second = await writeOptimizeRunNote(app, "two", "2026-10-05T10:00:00.000Z");
    expect(first).toBe("Claude/Optimize/Tag merges 2026-10-05 1000.md");
    expect(second).not.toBe(first);
    expect(await read(app as never, first)).toBe("one");
  });

  it("names the note after the given title", async () => {
    const app = new App() as never as import("obsidian").App;
    expect(await writeOptimizeRunNote(app, "x", "2026-10-05T10:00:00.000Z", "Link weave")).toBe("Claude/Optimize/Link weave 2026-10-05 1000.md");
  });
});

const type = (name: string, relations: string[]): ResolvedType => ({ name, version: 1, lineage: [name], properties: [], relations: relations.map((key) => ({ key, targets: ["entity"] })) });
const registry = (...types: ResolvedType[]) => ({ resolve: (n: string) => types.find((t) => t.name === n), resolved: () => new Map(types.map((t) => [t.name, t])) as ReadonlyMap<string, ResolvedType> });

describe("acceptsRelated", () => {
  it("accepts untyped notes and every note when no ontology is loaded", () => {
    expect(acceptsRelated(undefined, registry(type("person", [])))).toBe(true);
    expect(acceptsRelated("person", null)).toBe(true);
    expect(acceptsRelated("person", registry())).toBe(true);
  });

  it("accepts a typed note only when its resolved type declares related", () => {
    const reg = registry(type("entity", ["related"]), type("person", ["related", "knows"]), type("tool", ["uses"]));
    expect(acceptsRelated("person", reg)).toBe(true);
    expect(acceptsRelated("tool", reg)).toBe(false);
    expect(acceptsRelated("ghost", reg)).toBe(false);
  });
});

describe("acceptsRelated with the seeded ontology", () => {
  const { resolved } = resolveTypes([...SEED_TYPES, { name: "island", version: 1, properties: [], relations: [] }]);
  const real = { resolve: (n: string) => resolved.get(n), resolved: () => resolved as ReadonlyMap<string, ResolvedType> };

  it("accepts a seeded type that extends entity and refuses a root type without related", () => {
    expect(acceptsRelated("person", real)).toBe(true);
    expect(acceptsRelated("claim", real)).toBe(true);
    expect(acceptsRelated("island", real)).toBe(false);
  });
});

describe("linkScanNotes", () => {
  it("reads basename, aliases (list or string), mtime and string type", () => {
    const app = new App();
    app.vault.seed("a/Café.md", "x", { mtime: 5, frontmatter: { aliases: ["Cafe", 7], type: "tool" } });
    app.vault.seed("b.md", "x", { mtime: 6, frontmatter: { aliases: "Bee", type: 3 } });
    app.vault.seed("c.md", "x", { mtime: 7 });
    const notes = linkScanNotes(app as never, registry(type("tool", ["uses"])));
    expect(notes).toEqual([
      { path: "a/Café.md", basename: "Café", aliases: ["Cafe", "7"], mtime: 5, type: "tool", acceptsRelated: false },
      { path: "b.md", basename: "b", aliases: ["Bee"], mtime: 6, acceptsRelated: true },
      { path: "c.md", basename: "c", aliases: [], mtime: 7, acceptsRelated: true },
    ]);
  });
});

describe("processNoteBody", () => {
  it("transforms the current content and throws for a missing note", async () => {
    const app = new App();
    const file = app.vault.seed("n.md", "old");
    await processNoteBody(app as never, "n.md", (c) => `${c}!`);
    expect(file._content).toBe("old!");
    await expect(processNoteBody(app as never, "gone.md", (c) => c)).rejects.toThrow("Note not found: gone.md");
  });
});

describe("addRelatedLinks", () => {
  function withFrontmatter(initial: Record<string, unknown> | undefined) {
    const app = new App();
    const file = app.vault.seed("o.md", "body");
    let fm: Record<string, unknown> | undefined = initial;
    let calls = 0;
    app.fileManager.processFrontMatter = async (_f, fn) => {
      calls++;
      fm ??= {};
      fn(fm);
    };
    return { app: app as never, file, fm: () => fm, calls: () => calls };
  }

  it("creates the related list on a note with no frontmatter, keeping Unicode and emoji text", async () => {
    const ctx = withFrontmatter(undefined);
    expect(await addRelatedLinks(ctx.app, "o.md", ["[[Café]]", "[[🧠 Brain]]", "[[2024]]"])).toEqual({ ok: true, added: ["[[Café]]", "[[🧠 Brain]]", "[[2024]]"] });
    expect(ctx.fm()?.related).toEqual(["[[Café]]", "[[🧠 Brain]]", "[[2024]]"]);
  });

  it("keeps existing values in order for a string, a list, a list with a non-string, and null", async () => {
    for (const [existing, expected] of [
      ["[[Old]]", ["[[Old]]", "[[N]]"]],
      [["[[Z]]", "[[A]]"], ["[[Z]]", "[[A]]", "[[N]]"]],
      [["[[Z]]", { k: 1 }], ["[[Z]]", { k: 1 }, "[[N]]"]],
      [null, ["[[N]]"]],
    ] as Array<[unknown, unknown[]]>) {
      const ctx = withFrontmatter({ related: existing, other: "kept" });
      await addRelatedLinks(ctx.app, "o.md", ["[[N]]"]);
      expect(ctx.fm()).toEqual({ related: expected, other: "kept" });
    }
  });

  it("leaves an object value untouched and reports it", async () => {
    const ctx = withFrontmatter({ related: { a: 1 } });
    expect(await addRelatedLinks(ctx.app, "o.md", ["[[N]]"])).toEqual({ ok: false, message: "related is not a list" });
    expect(ctx.fm()).toEqual({ related: { a: 1 } });
  });

  it("does not write when every entry is already present", async () => {
    const ctx = withFrontmatter({ related: ["[[N|alias]]"] });
    expect(await addRelatedLinks(ctx.app, "o.md", ["[[N]]"])).toEqual({ ok: true, added: [] });
    expect(ctx.fm()).toEqual({ related: ["[[N|alias]]"] });
  });

  it("keeps the existing entries first through the fake processFrontMatter", async () => {
    const app = new App();
    const file = app.vault.seed("o.md", "---\nrelated:\n  - \"[[Old]]\"\n---\nbody");
    await addRelatedLinks(app as never, "o.md", ["[[Café]]"]);
    expect(file._content).toContain('"[[Old]]"');
    expect(file._content.indexOf("[[Old]]")).toBeLessThan(file._content.indexOf("[[Café]]"));
    expect(file._content).toContain("body");
  });

  it("throws for a missing note", async () => {
    await expect(addRelatedLinks(new App() as never, "gone.md", ["[[N]]"])).rejects.toThrow("Note not found: gone.md");
  });
});
