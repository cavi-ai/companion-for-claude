// Compact system-prompt digest of the resolved ontology so the model emits
// conforming frontmatter on notes it creates (spec 2026-07-08 §3.1). Pure.

import type { ResolvedType } from "./types";

export function ontologyDigest(types: ResolvedType[]): string {
  if (types.length === 0) return "";
  const lines = types.map((t) => {
    const props = t.properties.map((p) => `${p.key}${p.required ? "" : "?"} (${p.type})`).join(", ");
    const rels = t.relations.map((r) => `${r.key} → ${r.targets.join("|")}`).join(", ");
    let line = `- ${t.name}`;
    if (props) line += `: ${props}`;
    if (rels) line += `${props ? ";" : ":"} relations: ${rels}`;
    return line;
  });
  return [
    "The vault has an ontology. When you create a note, set frontmatter `type` to one of the types below and fill its properties. Relation fields hold lists of wikilink strings, e.g. works_on: [\"[[Project X]]\"]. Only add relations to notes you know exist or are creating.",
    ...lines,
  ].join("\n");
}
