// Turns an agent's type proposal into a schema note, or a list of rule violations. Pure.

import { BASE_KEYS } from "./conform";
import { schemaNoteContent } from "./seed";
import { PROPERTY_TYPES, ROOT_TYPE, type PropertyDef, type PropertyType, type RelationDef, type TypeDef } from "./types";

export type ProposalOutcome = { ok: true; def: TypeDef; fileName: string; content: string } | { ok: false; errors: string[] };

const NAME = /^[a-z][a-z0-9-]*$/;
const KEY = /^[a-z][a-z0-9_-]*$/;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function validateProposal(existing: ReadonlySet<string>, proposal: unknown): ProposalOutcome {
  if (!proposal || typeof proposal !== "object" || typeof (proposal as { name?: unknown }).name !== "string") {
    return { ok: false, errors: ["The proposal must be an object with a 'name'."] };
  }
  const p = proposal as { name: string; parent?: unknown; properties?: unknown; relations?: unknown };
  const errors: string[] = [];
  const name = p.name.trim();
  if (!NAME.test(name)) errors.push(`The name '${name}' must be lowercase kebab-case (a-z, 0-9, dashes).`);
  else if (existing.has(name)) return { ok: false, errors: [`A type named '${name}' already exists.`] };

  const parent = str(p.parent)?.trim() || ROOT_TYPE;
  if (parent !== ROOT_TYPE && !existing.has(parent)) errors.push(`The parent '${parent}' is not a known type.`);

  const properties: PropertyDef[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(p.properties) ? p.properties : []) {
    const key = str((raw as { key?: unknown })?.key)?.trim() ?? "";
    const type = str((raw as { type?: unknown })?.type)?.trim() ?? "";
    if (!KEY.test(key)) errors.push(`The property key '${key}' must be lowercase (a-z, 0-9, dashes, underscores).`);
    if (BASE_KEYS.has(key)) errors.push(`The property key '${key}' is reserved for every note.`);
    if (seen.has(key)) errors.push(`The proposal has a duplicate key '${key}'.`);
    seen.add(key);
    if (!PROPERTY_TYPES.has(type)) errors.push(`The property type '${type}' is not one of: ${[...PROPERTY_TYPES].join(", ")}.`);
    properties.push({ key, type: type as PropertyType, required: (raw as { required?: unknown })?.required === true, description: str((raw as { description?: unknown })?.description) });
  }

  const relations: RelationDef[] = [];
  const allowedTargets = new Set([...existing, ROOT_TYPE, name]);
  for (const raw of Array.isArray(p.relations) ? p.relations : []) {
    const key = str((raw as { key?: unknown })?.key)?.trim() ?? "";
    if (!KEY.test(key)) errors.push(`The relation key '${key}' must be lowercase (a-z, 0-9, dashes, underscores).`);
    if (seen.has(key)) errors.push(`The proposal has a duplicate key '${key}'.`);
    seen.add(key);
    const targets = (Array.isArray((raw as { targets?: unknown })?.targets) ? ((raw as { targets: unknown[] }).targets) : []).filter((t): t is string => typeof t === "string");
    if (targets.length === 0) errors.push(`The relation '${key}' needs at least one target type.`);
    for (const t of targets) if (!allowedTargets.has(t)) errors.push(`The relation '${key}' has an unknown target '${t}'.`);
    relations.push({ key, targets, description: str((raw as { description?: unknown })?.description) });
  }

  if (errors.length > 0) return { ok: false, errors };
  const def: TypeDef = { name, version: 1, extendsType: parent, properties, relations };
  return { ok: true, def, fileName: `${name}.md`, content: schemaNoteContent(def) };
}
