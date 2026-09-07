// The registry as agents read it (ontology_get). Pure.

import type { ResolvedType } from "./types";

export interface TypeSummary {
  name: string;
  lineage: string[];
  version: number;
  properties: Array<{ key: string; type: string; required: boolean; description?: string }>;
  relations: Array<{ key: string; targets: string[]; description?: string }>;
}

export interface OntologyDescription {
  types: TypeSummary[];
  note?: string;
}

function summarize(t: ResolvedType): TypeSummary {
  return {
    name: t.name,
    lineage: [...t.lineage],
    version: t.version,
    properties: t.properties.map((p) => ({ key: p.key, type: p.type, required: p.required, ...(p.description !== undefined ? { description: p.description } : {}) })),
    relations: t.relations.map((r) => ({ key: r.key, targets: [...r.targets], ...(r.description !== undefined ? { description: r.description } : {}) })),
  };
}

export function describeOntology(resolved: ReadonlyMap<string, ResolvedType>, name?: string): OntologyDescription {
  if (resolved.size === 0) return { types: [], note: "No ontology is seeded." };
  if (name === undefined) return { types: [...resolved.values()].map(summarize) };
  const target = resolved.get(name);
  if (!target) return { types: [], note: `Unknown type '${name}'. Available: ${[...resolved.keys()].sort().join(", ")}` };
  const chain = target.lineage.map((n) => resolved.get(n)).filter((t): t is ResolvedType => t !== undefined);
  return { types: chain.map(summarize) };
}
