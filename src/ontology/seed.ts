// Default ontology seeded by the "Seed ontology" command (spec 2026-07-08 §1).
// Type names and properties mirror the frontmatter the plugin already writes
// (artifactStore, sourceNote, consolidate, handoffToBuild) so typed notes
// don't self-flag; source types are mirrored from the shipped source-capture
// schemas so the two never drift.

import { getSchema } from "../sources/registry";
import type { SourceType } from "../sources/types";
import type { TypeDef } from "./types";

function fromSourceSchema(sourceType: SourceType): TypeDef {
  const s = getSchema(sourceType);
  return {
    name: sourceType,
    version: s.version,
    extendsType: "source",
    // title/summary are universal base keys — the ontology doesn't redeclare them.
    properties: s.fields
      .filter((f) => f.key !== "title" && f.key !== "summary")
      .map((f) => {
        const p: TypeDef["properties"][number] = { key: f.key, type: f.type, required: f.required };
        if (f.description) p.description = f.description;
        return p;
      }),
    relations: [],
  };
}

export const SEED_TYPES: TypeDef[] = [
  { name: "entity", version: 1, properties: [], relations: [{ key: "related", targets: ["entity"], description: "any related typed note" }] },
  {
    name: "person", version: 1, extendsType: "entity",
    properties: [{ key: "role", type: "string", required: false, description: "what this person does" }],
    relations: [
      { key: "works_on", targets: ["project"], description: "projects this person contributes to" },
      { key: "knows", targets: ["person"] },
    ],
  },
  {
    name: "project", version: 1, extendsType: "entity",
    properties: [{ key: "status", type: "string", required: false, description: "e.g. active, paused, done" }],
    relations: [
      { key: "part_of", targets: ["project"], description: "parent project or initiative" },
      { key: "contributors", targets: ["person"] },
    ],
  },
  {
    name: "concept", version: 1, extendsType: "entity",
    properties: [],
    relations: [{ key: "broader", targets: ["concept"], description: "the more general concept" }],
  },
  {
    name: "meeting", version: 1, extendsType: "entity",
    properties: [{ key: "date", type: "date", required: false }],
    relations: [
      { key: "attendees", targets: ["person"] },
      { key: "about", targets: ["entity"], description: "what the meeting concerned" },
    ],
  },
  {
    name: "source", version: 1, extendsType: "entity",
    properties: [
      { key: "url", type: "string", required: false, description: "where this was captured from" },
      { key: "captured_at", type: "string", required: false },
      { key: "asset", type: "string", required: false, description: "vault path of the captured asset file" },
      { key: "source_enriched", type: "boolean", required: false },
      { key: "schema_version", type: "number", required: false },
      { key: "enriched_by", type: "string", required: false },
    ],
    relations: [{ key: "about", targets: ["entity"], description: "what this source is about" }],
  },
  fromSourceSchema("article"),
  fromSourceSchema("video"),
  fromSourceSchema("dataset"),
  { name: "chat", version: 1, extendsType: "entity", properties: [], relations: [] },
  { name: "artifact", version: 1, extendsType: "entity", properties: [], relations: [] },
  { name: "plan", version: 1, extendsType: "entity", properties: [], relations: [] },
  { name: "build-spec", version: 1, extendsType: "entity", properties: [], relations: [] },
  { name: "build-tracker", version: 1, extendsType: "entity", properties: [], relations: [] },
  {
    name: "research-project", version: 1, extendsType: "entity",
    properties: [
      { key: "question", type: "string", required: true },
      { key: "audience", type: "string", required: false },
      { key: "stage", type: "string", required: true },
      { key: "status", type: "string", required: true },
    ],
    relations: [{ key: "project", targets: ["research-project"], description: "owning research project" }],
  },
  {
    name: "research-source", version: 1, extendsType: "entity",
    properties: [
      { key: "sourceKind", type: "string", required: true },
      { key: "canonicalId", type: "string", required: false },
      { key: "url", type: "string", required: false },
      { key: "asset", type: "string", required: false },
      { key: "contentFingerprint", type: "string", required: false },
    ],
    relations: [{ key: "project", targets: ["research-project"], description: "owning research project" }],
  },
  {
    name: "evidence", version: 1, extendsType: "entity",
    properties: [
      { key: "source_fingerprint", type: "string", required: false },
      { key: "locator_kind", type: "string", required: false },
      { key: "locator_value", type: "string", required: false },
      { key: "excerpt", type: "string", required: true },
      { key: "interpretation", type: "string", required: false },
      { key: "reviewState", type: "string", required: true },
      { key: "model", type: "string", required: false },
    ],
    relations: [
      { key: "source", targets: ["research-source"], description: "source record this evidence came from" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
  {
    name: "claim", version: 1, extendsType: "entity",
    properties: [
      { key: "proposition", type: "string", required: true },
      { key: "confidence", type: "string", required: true },
      { key: "reviewState", type: "string", required: true },
      { key: "limitations", type: "string[]", required: true },
    ],
    relations: [
      { key: "supports", targets: ["evidence"], description: "evidence supporting this claim" },
      { key: "challenges", targets: ["evidence"], description: "evidence challenging this claim" },
      { key: "contextualizes", targets: ["evidence"], description: "evidence providing context for this claim" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
  {
    name: "research-question", version: 1, extendsType: "entity",
    properties: [
      { key: "question", type: "string", required: true },
      { key: "status", type: "string", required: true },
    ],
    relations: [
      { key: "about", targets: ["entity"], description: "subject of the question" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
  {
    name: "research-document", version: 1, extendsType: "entity",
    properties: [{ key: "documentKind", type: "string", required: true }],
    relations: [
      { key: "claims", targets: ["claim"], description: "claims used by this document" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
  {
    // Mirrors renderMemoryNote (src/memory/consolidate.ts): updated + digests
    // alongside the universal base keys.
    name: "claude-memory", version: 1, extendsType: "entity",
    properties: [
      { key: "updated", type: "date", required: false, description: "date of the last consolidation run" },
      { key: "digests", type: "number", required: false, description: "how many session digests were folded in" },
    ],
    relations: [],
  },
];

function yamlBlock(def: TypeDef): string {
  const lines: string[] = [];
  if (def.extendsType) lines.push(`extends: ${def.extendsType}`);
  if (def.properties.length > 0) {
    lines.push("properties:");
    for (const p of def.properties) {
      lines.push(`  - key: ${p.key}`, `    type: ${JSON.stringify(p.type)}`);
      if (p.required) lines.push("    required: true");
      if (p.description) lines.push(`    description: ${JSON.stringify(p.description)}`);
    }
  }
  if (def.relations.length > 0) {
    lines.push("relations:");
    for (const r of def.relations) {
      lines.push(`  - key: ${r.key}`, `    targets: [${r.targets.join(", ")}]`);
      if (r.description) lines.push(`    description: ${JSON.stringify(r.description)}`);
    }
  }
  return lines.join("\n");
}

/** Serialize a TypeDef as a schema note (frontmatter markers + yaml block + doc hint). */
export function schemaNoteContent(def: TypeDef): string {
  const fm = ["---", "ontology: type", `type_name: ${def.name}`, `version: ${def.version}`, "---"].join("\n");
  const block = yamlBlock(def);
  const body = block ? ["", "```yaml", block, "```", ""] : [""];
  return [fm, ...body, `Edit the yaml block above to change the \`${def.name}\` schema. Prose here is documentation — the plugin ignores it.`, ""].join("\n");
}

/** File name per type. Names are flat kebab already (claude-memory etc.). */
export function seedFiles(): Array<{ fileName: string; content: string }> {
  return SEED_TYPES.map((def) => ({ fileName: `${def.name}.md`, content: schemaNoteContent(def) }));
}
