import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_EXPANDED_MATCHES, MAX_RELATION_EXPANSION, noteType, planRelationExpansion, typeLabel, typeMatches } from "../../src/context/typedContext";
import { extractEdges, type RelationEdge } from "../../src/ontology/relations";
import type { ResolvedType } from "../../src/ontology/types";

const person: ResolvedType = {
  name: "person",
  version: 1,
  lineage: ["person", "entity"],
  properties: [],
  relations: [
    { key: "works_on", targets: ["project"] },
    { key: "knows", targets: ["person"] },
  ],
};

function edges(map: Record<string, Array<[string, string]>>): (path: string) => RelationEdge[] {
  return (path) => (map[path] ?? []).map(([key, to]) => ({ from: path, key, to }));
}

const byName = (name: string): string | null => `N/${name}.md`;

function plan(over: Partial<Parameters<typeof planRelationExpansion>[0]> = {}) {
  return planRelationExpansion({
    matches: [],
    edgesOf: () => [],
    resolve: byName,
    include: () => true,
    already: new Set<string>(),
    limit: MAX_RELATION_EXPANSION,
    ...over,
  });
}

describe("noteType / typeLabel", () => {
  it("reads a non-blank string type only, exactly as written", () => {
    expect(noteType({ type: "article" })).toBe("article");
    expect(noteType({ type: "  article " })).toBe("  article ");
    expect(noteType({ type: ["article"] })).toBeUndefined();
    expect(noteType({ type: "  " })).toBeUndefined();
    expect(noteType({ type: 3 })).toBeUndefined();
    expect(noteType(undefined)).toBeUndefined();
  });

  it("labels a typed note and leaves an untyped one bare", () => {
    expect(typeLabel("article")).toBe(" (type: article)");
    expect(typeLabel(undefined)).toBe("");
  });
});

describe("typeMatches", () => {
  const lineage = (t: string): readonly string[] | undefined => ({ article: ["article", "source", "entity"] } as Record<string, string[]>)[t];
  it("matches exactly, or through the note type's lineage", () => {
    expect(typeMatches("article", "article", lineage)).toBe(true);
    expect(typeMatches("article", "source", lineage)).toBe(true);
    expect(typeMatches("article", "entity", lineage)).toBe(true);
    expect(typeMatches("source", "article", lineage)).toBe(false);
  });
  it("falls back to the exact, case-sensitive match for unknown types or no lineage", () => {
    expect(typeMatches("memo", "source", lineage)).toBe(false);
    expect(typeMatches("memo", "memo", lineage)).toBe(true);
    expect(typeMatches("article", "source")).toBe(false);
    expect(typeMatches("article", "Source", lineage)).toBe(false);
  });
});

describe("planRelationExpansion", () => {
  it("walks matches in rank order and each match's edges in declaration order", () => {
    const out = plan({
      matches: ["m1.md", "m2.md"],
      edgesOf: edges({ "m1.md": [["works_on", "A"], ["knows", "B"]], "m2.md": [["knows", "C"]] }),
    });
    expect(out).toEqual([
      { key: "works_on", from: "m1.md", path: "N/A.md" },
      { key: "knows", from: "m1.md", path: "N/B.md" },
      { key: "knows", from: "m2.md", path: "N/C.md" },
    ]);
  });

  it("caps targets at the limit and walks at most MAX_EXPANDED_MATCHES matches", () => {
    expect(MAX_RELATION_EXPANSION).toBe(3);
    expect(MAX_EXPANDED_MATCHES).toBe(3);
    const many = plan({ matches: ["m1.md"], edgesOf: edges({ "m1.md": [["k", "A"], ["k", "B"], ["k", "C"], ["k", "D"]] }) });
    expect(many.map((e) => e.path)).toEqual(["N/A.md", "N/B.md", "N/C.md"]);
    const fourth = plan({
      matches: ["m1.md", "m2.md", "m3.md", "m4.md"],
      edgesOf: edges({ "m4.md": [["k", "D"]] }),
    });
    expect(fourth).toEqual([]);
    expect(plan({ matches: ["m1.md"], edgesOf: edges({ "m1.md": [["k", "A"]] }), limit: 0 })).toEqual([]);
  });

  it("caps related entries at 3 across all matches", () => {
    const out = plan({
      matches: ["m1.md", "m2.md"],
      edgesOf: edges({ "m1.md": [["k", "A"], ["k", "B"]], "m2.md": [["k", "C"], ["k", "D"]] }),
    });
    expect(out).toEqual([
      { key: "k", from: "m1.md", path: "N/A.md" },
      { key: "k", from: "m1.md", path: "N/B.md" },
      { key: "k", from: "m2.md", path: "N/C.md" },
    ]);
  });

  it("skips targets outside the scope, already in context, the match itself, and other matches", () => {
    const out = plan({
      matches: ["N/M1.md", "N/M2.md"],
      edgesOf: edges({ "N/M1.md": [["k", "Out"], ["k", "Active"], ["k", "M1"], ["k", "M2"], ["k", "Ok"]] }),
      include: (p) => p !== "N/Out.md",
      already: new Set(["N/Active.md"]),
    });
    expect(out).toEqual([{ key: "k", from: "N/M1.md", path: "N/Ok.md" }]);
  });

  it("adds a target reached through two edges once", () => {
    const out = plan({ matches: ["m1.md", "m2.md"], edgesOf: edges({ "m1.md": [["works_on", "A"], ["knows", "A"]], "m2.md": [["knows", "A"]] }) });
    expect(out).toEqual([{ key: "works_on", from: "m1.md", path: "N/A.md" }]);
  });

  it("skips unresolved targets without spending the cap", () => {
    const out = plan({
      matches: ["m1.md"],
      edgesOf: edges({ "m1.md": [["k", "Missing"], ["k", "A"], ["k", "Gone"], ["k", "B"], ["k", "C"]] }),
      resolve: (name) => (name === "Missing" || name === "Gone" ? null : `N/${name}.md`),
    });
    expect(out.map((e) => e.path)).toEqual(["N/A.md", "N/B.md", "N/C.md"]);
  });

  it("resolves alias and heading link text by the bare target, from the match's path", () => {
    const calls: Array<[string, string]> = [];
    const fm = { type: "person", works_on: ["[[Projects/Alpha|the alpha]]", "[[Beta#Scope]]"], knows: "[[Carol^b1]]" };
    const out = plan({
      matches: ["People/Ann.md"],
      edgesOf: (p) => extractEdges(p, fm, person),
      resolve: (linkpath, from) => {
        calls.push([linkpath, from]);
        return `${linkpath}.md`;
      },
    });
    expect(calls).toEqual([
      ["Projects/Alpha", "People/Ann.md"],
      ["Beta", "People/Ann.md"],
      ["Carol", "People/Ann.md"],
    ]);
    expect(out.map((e) => e.path)).toEqual(["Projects/Alpha.md", "Beta.md", "Carol.md"]);
  });
});

describe("pure typed-retrieval modules", () => {
  it.each(["typedContext.ts", "searchFilter.ts"])("%s never imports obsidian", (file) => {
    const source = readFileSync(fileURLToPath(new URL(`../../src/context/${file}`, import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']obsidian["']/);
  });
});
