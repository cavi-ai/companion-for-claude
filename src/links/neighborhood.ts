// One-hop graph neighborhood of a note: outgoing links, backlinks, and typed
// ontology relations — the grouped-lists alternative to a graph simulation.
// Pure; the RelatedView renders it.

import type { ResolvedType } from "../ontology/types";
import { extractEdges } from "../ontology/relations";

export interface TypedRelationRow {
  /** Relation key (e.g. "works_on"). */
  key: string;
  /** Link target as written (basename or path, alias/heading stripped). */
  to: string;
}

export interface Neighborhood {
  /** Paths this note links to (Obsidian-resolved). */
  outgoing: string[];
  /** Paths linking to this note. */
  incoming: string[];
  /** Typed relation edges declared in this note's frontmatter. */
  relations: TypedRelationRow[];
}

/**
 * Compute the neighborhood from Obsidian's resolved-links map (source →
 * target → count) plus the note's frontmatter and its resolved ontology type
 * (undefined when the note has no type or ontology is off).
 */
export function neighborhood(
  resolvedLinks: Record<string, Record<string, number>>,
  path: string,
  frontmatter?: Record<string, unknown>,
  type?: ResolvedType,
): Neighborhood {
  const outgoing = Object.keys(resolvedLinks[path] ?? {}).sort();
  const incoming: string[] = [];
  for (const [source, targets] of Object.entries(resolvedLinks)) {
    if (source !== path && targets[path]) incoming.push(source);
  }
  incoming.sort();
  const relations = frontmatter && type ? extractEdges(path, frontmatter, type).map(({ key, to }) => ({ key, to })) : [];
  return { outgoing, incoming, relations };
}
