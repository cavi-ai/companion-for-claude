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
    // Title is a universal base key. Summary is redeclared so source-derived
    // types retain the source schema's documented quality constraint.
    properties: s.fields
      .filter((f) => f.key !== "title")
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
    // Mirrors renderResearchRecord (src/research/render.ts).
    name: "research-source", version: 2, extendsType: "entity",
    properties: [
      { key: "source_kind", type: "string", required: true },
      { key: "canonical_id", type: "string", required: false },
      { key: "url", type: "string", required: false },
      { key: "asset", type: "string", required: false },
      { key: "content_fingerprint", type: "string", required: false },
      { key: "doi", type: "string", required: false },
      { key: "arxiv_id", type: "string", required: false },
      { key: "zotero_key", type: "string", required: false },
      { key: "authors", type: "string[]", required: false },
      { key: "published", type: "string", required: false },
      { key: "publication", type: "string", required: false },
      { key: "abstract", type: "string", required: false },
      { key: "open_access_url", type: "string", required: false },
      { key: "discovery_provenance", type: "list", required: false, description: "discovery adapters and their ids" },
    ],
    relations: [{ key: "project", targets: ["research-project"], description: "owning research project" }],
  },
  {
    // The excerpt lives in the body as a quote, not in frontmatter.
    name: "evidence", version: 2, extendsType: "entity",
    properties: [
      { key: "source_fingerprint", type: "string", required: false },
      { key: "locator_kind", type: "string", required: false },
      { key: "locator_value", type: "string", required: false },
      { key: "interpretation", type: "string", required: false },
      { key: "review_state", type: "string", required: true },
      { key: "model", type: "string", required: false },
    ],
    relations: [
      { key: "source", targets: ["research-source"], description: "source record this evidence came from" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
  {
    name: "claim", version: 2, extendsType: "entity",
    properties: [
      { key: "proposition", type: "string", required: true },
      { key: "confidence", type: "string", required: true },
      { key: "review_state", type: "string", required: true },
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
    name: "research-document", version: 2, extendsType: "entity",
    properties: [{ key: "document_kind", type: "string", required: true }],
    relations: [
      { key: "claims", targets: ["claim"], description: "claims used by this document" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
  {
    // Mirrors renderDistilledNote (src/conversations/distill.ts).
    name: "chat-summary", version: 1, extendsType: "entity",
    properties: [{ key: "conversation", type: "string", required: false, description: "id of the summarized conversation" }],
    relations: [],
  },
  {
    // Mirrors projectNoteBody and parseProjectNote (src/projects/model.ts).
    name: "chat-project", version: 1, extendsType: "entity",
    properties: [
      { key: "folder", type: "string", required: false, description: "folder that scopes the project's context" },
      { key: "pinned", type: "string[]", required: false, description: "notes always attached to the project's chats" },
    ],
    relations: [],
  },
  {
    // Mirrors renderTriageNote (src/research/triage.ts).
    name: "triage", version: 1, extendsType: "entity",
    properties: [
      { key: "source_enriched", type: "boolean", required: false },
      { key: "generated", type: "date", required: false },
    ],
    relations: [],
  },
  {
    // Mirrors renderOrderRun (src/orders/output.ts).
    name: "order-run", version: 1, extendsType: "entity",
    properties: [
      { key: "order", type: "string", required: false, description: "the standing order that ran" },
      { key: "trigger", type: "string", required: false },
      { key: "proposed_edits", type: "number", required: false },
    ],
    relations: [],
  },
  {
    // Mirrors the Optimize brain run notes (src/optimize/mergePlan.ts, linkPlan.ts, typeController.ts).
    name: "optimize-run", version: 1, extendsType: "entity",
    properties: [
      { key: "merges", type: "number", required: false },
      { key: "links", type: "number", required: false },
      { key: "notes", type: "number", required: false },
    ],
    relations: [],
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

/** Version 1 of the research types, whose keys did not match what renderResearchRecord writes. */
const SUPERSEDED_SEED_TYPES: TypeDef[] = [
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
    name: "research-document", version: 1, extendsType: "entity",
    properties: [{ key: "documentKind", type: "string", required: true }],
    relations: [
      { key: "claims", targets: ["claim"], description: "claims used by this document" },
      { key: "project", targets: ["research-project"], description: "owning research project" },
    ],
  },
];

/** The schema note an earlier seed wrote for this file, when Seed ontology may replace an unedited copy. */
function supersededSeedContent(fileName: string): string | undefined {
  const def = SUPERSEDED_SEED_TYPES.find((d) => `${d.name}.md` === fileName);
  return def ? schemaNoteContent(def) : undefined;
}

export interface SeedWrite {
  fileName: string;
  content: string;
  /** Replaces an unedited superseded seed note instead of creating a missing one. */
  upgrade: boolean;
}

/** Schema notes to write: each missing type, and each superseded seed note nobody edited. Edited notes are never touched. */
export function planSeed(current: (fileName: string) => string | null): SeedWrite[] {
  const out: SeedWrite[] = [];
  for (const f of seedFiles()) {
    const existing = current(f.fileName);
    if (existing === null) out.push({ ...f, upgrade: false });
    else if (existing === supersededSeedContent(f.fileName)) out.push({ ...f, upgrade: true });
  }
  return out;
}

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
