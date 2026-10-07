// Note types and typed-relation expansion for chat context; pure, no Obsidian imports.

import type { RelationEdge } from "../ontology/relations";

/** Search matches whose typed relations are followed, in rank order. */
export const MAX_EXPANDED_MATCHES = 3;
/** Related notes added to one context, across all matches. */
export const MAX_RELATION_EXPANSION = 3;

export interface RelationExpansion {
  key: string;
  /** The search match declaring the relation. */
  from: string;
  /** Resolved vault path of the target note. */
  path: string;
}

export interface RelationExpansionInput {
  matches: readonly string[];
  edgesOf: (path: string) => readonly RelationEdge[];
  /** Vault path of the markdown note a linkpath resolves to from `fromPath`, or null. */
  resolve: (linkpath: string, fromPath: string) => string | null;
  include: (path: string) => boolean;
  already: ReadonlySet<string>;
  limit: number;
}

/** The `type` exactly as written (no trim, matching `conform`), or undefined when blank or not a string. */
export function noteType(frontmatter: Record<string, unknown> | undefined): string | undefined {
  const t = frontmatter?.type;
  return typeof t === "string" && t.trim() ? t : undefined;
}

export function typeLabel(type: string | undefined): string {
  return type ? ` (type: ${type})` : "";
}

export function typeMatches(type: string, wanted: string, lineageOf?: (type: string) => readonly string[] | undefined): boolean {
  return type === wanted || (lineageOf?.(type)?.includes(wanted) ?? false);
}

export function planRelationExpansion(input: RelationExpansionInput): RelationExpansion[] {
  const out: RelationExpansion[] = [];
  const seen = new Set<string>([...input.already, ...input.matches]);
  for (const from of input.matches.slice(0, MAX_EXPANDED_MATCHES)) {
    for (const edge of input.edgesOf(from)) {
      if (out.length >= input.limit) return out;
      const path = input.resolve(edge.to, from);
      if (path === null || seen.has(path) || !input.include(path)) continue;
      seen.add(path);
      out.push({ key: edge.key, from, path });
    }
  }
  return out;
}
