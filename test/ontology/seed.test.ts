import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { SEED_TYPES, seedFiles, schemaNoteContent } from "../../src/ontology/seed";
import { parseSchemaNote, resolveTypes } from "../../src/ontology/schema";
import { conform } from "../../src/ontology/conform";

/** Split a serialized schema note into (frontmatter object, body) the way Obsidian would. */
function splitNote(content: string): { fm: Record<string, unknown>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("no frontmatter");
  return { fm: parseYaml(m[1] ?? "") as Record<string, unknown>, body: m[2] ?? "" };
}

describe("SEED_TYPES", () => {
  it("covers the spec's default types, named to match what the plugin already writes", () => {
    const names = SEED_TYPES.map((t) => t.name);
    for (const expected of ["entity", "person", "project", "concept", "meeting", "source", "article", "video", "dataset", "chat", "artifact", "plan", "claude-memory", "build-spec", "build-tracker"]) {
      expect(names).toContain(expected);
    }
  });
  it("resolves without errors", () => {
    const { errors } = resolveTypes(SEED_TYPES);
    expect(errors).toEqual([]);
  });
  it("mirrors the shipped source schemas (article keeps its fields)", () => {
    const article = SEED_TYPES.find((t) => t.name === "article")!;
    expect(article.extendsType).toBe("source");
    expect(article.properties.map((p) => p.key)).toContain("site");
  });
  it("ships the research evidence relation contracts", () => {
    const relations = (name: string) => SEED_TYPES.find((t) => t.name === name)?.relations;
    expect(relations("research-source")).toContainEqual(expect.objectContaining({ key: "project", targets: ["research-project"] }));
    expect(relations("evidence")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "source", targets: ["research-source"] }),
      expect.objectContaining({ key: "project", targets: ["research-project"] }),
    ]));
    expect(relations("claim")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "supports", targets: ["evidence"] }),
      expect.objectContaining({ key: "challenges", targets: ["evidence"] }),
      expect.objectContaining({ key: "contextualizes", targets: ["evidence"] }),
      expect.objectContaining({ key: "project", targets: ["research-project"] }),
    ]));
    expect(relations("research-document")).toContainEqual(expect.objectContaining({ key: "claims", targets: ["claim"] }));
    expect(SEED_TYPES.find((t) => t.name === "evidence")?.properties).toContainEqual(
      expect.objectContaining({ key: "source_fingerprint", type: "string", required: false }),
    );
  });
});

describe("schemaNoteContent round-trip", () => {
  it("every seeded note parses back to its TypeDef", () => {
    for (const def of SEED_TYPES) {
      const { fm, body } = splitNote(schemaNoteContent(def));
      const r = parseSchemaNote(`Ontology/${def.name}.md`, fm, body, parseYaml);
      expect(r.errors, def.name).toEqual([]);
      expect(r.def, def.name).toEqual(def);
    }
  });
});

describe("seedFiles", () => {
  it("emits one file per type with safe names", () => {
    const files = seedFiles();
    expect(files).toHaveLength(SEED_TYPES.length);
    for (const f of files) expect(f.fileName).toMatch(/^[a-z-]+\.md$/);
  });
});

describe("plugin-written notes conform to the seeded ontology", () => {
  const { resolved } = resolveTypes(SEED_TYPES);
  const noLookup = () => undefined;
  it("artifactStore-shape frontmatter conforms to `artifact`", () => {
    const fm = { title: "T", created: "2026-07-08", source: "claude-companion", type: "artifact", summary: "s", tags: ["claude"] };
    expect(conform(fm, resolved.get("artifact"), noLookup).ok).toBe(true);
  });
  it("chat, plan, build-spec, build-tracker shapes conform", () => {
    const base = { title: "T", created: "2026-07-08", source: "claude-companion", tags: ["claude"] };
    for (const t of ["chat", "plan", "build-spec", "build-tracker"]) {
      expect(conform({ ...base, type: t }, resolved.get(t), noLookup).ok, t).toBe(true);
    }
  });
  it("enriched source-note frontmatter conforms to `article` (sourceNote.ts shape)", () => {
    const fm = {
      type: "article", title: "T", site: "Example", summary: "s", tags: ["source"],
      url: "https://x", source_enriched: true, schema_version: 1, captured_at: "2026-07-08T00:00:00Z", enriched_by: "claude",
    };
    expect(conform(fm, resolved.get("article"), noLookup).ok).toBe(true);
  });
  it("claude-memory note frontmatter conforms (consolidate.ts shape)", () => {
    // Exactly what renderMemoryNote writes: title, type, source, updated (YYYY-MM-DD), digests (count), tags.
    const fm = {
      title: "What Claude Knows", type: "claude-memory", source: "claude-companion",
      updated: "2026-07-08", digests: 5, tags: ["claude", "memory"],
    };
    expect(conform(fm, resolved.get("claude-memory"), noLookup).ok).toBe(true);
  });
});
