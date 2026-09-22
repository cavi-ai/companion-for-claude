// Frontmatter and tag filters for vault_search; pure, no Obsidian imports.

import { parseWikilink } from "../ontology/relations";

export interface SearchFilter {
  type?: string;
  project?: string;
  tag?: string;
}

const PROVENANCE_KEYS = ["type", "project", "review_state", "source_kind", "canonical_id", "url"] as const;
const FILTER_KEYS = ["type", "project", "tag"] as const;

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Trimmed non-empty strings from a string or arbitrarily nested arrays; anything else is []. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(strings);
  return [];
}

export function parseSearchFilter(args: Record<string, unknown>): SearchFilter | null {
  const type = text(args.type);
  const project = text(args.project);
  const tag = text(args.tag)?.replace(/^#/, "");
  const filter: SearchFilter = { ...(type ? { type } : {}), ...(project ? { project } : {}), ...(tag ? { tag } : {}) };
  return Object.keys(filter).length > 0 ? filter : null;
}

export function normalizeProjectRef(v: string): string {
  return (parseWikilink(v) ?? v.trim()).replace(/\.md$/i, "").toLowerCase();
}

/** `want` matches `have` itself (or a /-bounded suffix), or have's parent dir (or a /-bounded suffix of it). */
function oneProjectMatches(have: string, want: string): boolean {
  if (have === want || have.endsWith(`/${want}`)) return true;
  const parent = have.includes("/") ? have.slice(0, have.lastIndexOf("/")) : have;
  return parent === want || parent.endsWith(`/${want}`);
}

function projectMatches(value: unknown, wanted: string): boolean {
  const want = normalizeProjectRef(wanted);
  return strings(value).some((s) => oneProjectMatches(normalizeProjectRef(s), want));
}

function tagMatches(tags: readonly string[], wanted: string): boolean {
  const w = wanted.toLowerCase();
  return tags.some((t) => {
    const x = t.replace(/^#/, "").toLowerCase();
    return x === w || x.startsWith(`${w}/`);
  });
}

export function matchesSearchFilter(frontmatter: Record<string, unknown> | undefined, tags: readonly string[], filter: SearchFilter): boolean {
  if (filter.type !== undefined && !strings(frontmatter?.type).includes(filter.type)) return false;
  if (filter.project !== undefined && !projectMatches(frontmatter?.project, filter.project)) return false;
  if (filter.tag !== undefined && !tagMatches(tags, filter.tag)) return false;
  return true;
}

export function hitMetadata(frontmatter: Record<string, unknown> | undefined): string {
  if (!frontmatter) return "";
  return PROVENANCE_KEYS.flatMap((k) => {
    const vals = strings(frontmatter[k]);
    return vals.length ? [`${k}: ${vals.join(", ").replace(/\s+/g, " ")}`] : [];
  }).join(" · ");
}

export function describeFilter(filter: SearchFilter): string {
  return FILTER_KEYS.flatMap((k) => (filter[k] !== undefined ? [`${k}: ${filter[k]}`] : [])).join(", ");
}
