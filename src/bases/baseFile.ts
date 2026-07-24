// Obsidian Bases (.base) generation (spec 2026-07-06): validate a model-
// proposed database view and emit the documented YAML schema (verified against
// obsidian.md/help/bases/syntax on 2026-07-06; view types, recursive filters,
// and summaries cross-checked against kepano/obsidian-skills obsidian-bases,
// pinned at upstream/obsidian-skills). Pure, dependency-free.

/** A filter statement, or exactly one and/or/not group over child filters. */
export type ProposedFilter =
  | string
  | { and: ProposedFilter[] }
  | { or: ProposedFilter[] }
  | { not: ProposedFilter[] };

export interface ProposedBaseView {
  /** View type; "table" (default), "cards", "list", or "map". */
  type?: string;
  name: string;
  /** Property order (e.g. "file.name", "note.status", "formula.ppu"). */
  order?: string[];
  /** Group rows by a property. */
  groupBy?: { property: string; direction?: "ASC" | "DESC" };
  /** Optional row cap. */
  limit?: number;
  /** View filters: a statement, a statement list (AND-ed), or one and/or/not group. */
  filters?: string[] | ProposedFilter;
  /** property id → summary: a built-in (e.g. "Sum") or a custom `summaries` key. */
  summaries?: Record<string, string>;
}

export interface ProposedBase {
  /** Global filters: a statement, a statement list (AND-ed), or one and/or/not group. */
  filters?: string[] | ProposedFilter;
  /** formula name → expression. */
  formulas?: Record<string, string>;
  /** property id → display name. */
  properties?: Record<string, string>;
  /** custom summary name → expression (e.g. {p90: "values.percentile(90)"}). */
  summaries?: Record<string, string>;
  views: ProposedBaseView[];
}

const MAX_VIEWS = 8;
const VIEW_TYPES = new Set(["table", "cards", "list", "map"]);
const BUILTIN_SUMMARIES = new Set([
  "Average", "Min", "Max", "Sum", "Range", "Median", "Stddev",
  "Earliest", "Latest", "Checked", "Unchecked", "Empty", "Filled", "Unique",
]);

/** Validate and serialize a proposal to .base YAML. Throws actionable errors. */
export function buildBaseFile(base: ProposedBase): string {
  if (!Array.isArray(base.views) || base.views.length === 0) throw new Error("A base needs at least one view.");
  if (base.views.length > MAX_VIEWS) throw new Error(`Too many views (${base.views.length}); at most ${MAX_VIEWS}.`);
  const customSummaries = new Set(Object.keys(base.summaries ?? {}));
  for (const [i, v] of base.views.entries()) {
    if (!v.name?.trim()) throw new Error(`View ${i + 1} needs a name.`);
    const type = v.type?.trim() || "table";
    if (!VIEW_TYPES.has(type)) {
      throw new Error(`View "${v.name}": unknown type "${type}" (use table, cards, list, map).`);
    }
    if (v.limit !== undefined && (!Number.isInteger(v.limit) || v.limit <= 0)) {
      throw new Error(`View "${v.name}": limit must be a positive integer.`);
    }
    for (const [prop, summary] of Object.entries(v.summaries ?? {})) {
      if (!BUILTIN_SUMMARIES.has(summary) && !customSummaries.has(summary)) {
        throw new Error(
          `View "${v.name}": unknown summary "${summary}" for "${prop}" — use a built-in (${[...BUILTIN_SUMMARIES].join(", ")}) or define it under summaries.`
        );
      }
    }
    if (v.filters !== undefined && !isEmptyFilter(v.filters)) validateFilter(normalizeFilter(v.filters));
  }
  if (base.filters !== undefined && !isEmptyFilter(base.filters)) validateFilter(normalizeFilter(base.filters));

  const lines: string[] = [];
  if (base.filters !== undefined && !isEmptyFilter(base.filters)) {
    emitFilter("filters:", normalizeFilter(base.filters), "", lines);
  }
  if (base.formulas && Object.keys(base.formulas).length > 0) {
    lines.push("formulas:");
    for (const [k, v] of Object.entries(base.formulas)) lines.push(`  ${k}: ${q(v)}`);
  }
  if (base.properties && Object.keys(base.properties).length > 0) {
    lines.push("properties:");
    for (const [k, v] of Object.entries(base.properties)) {
      lines.push(`  ${k}:`, `    displayName: ${q(v)}`);
    }
  }
  if (base.summaries && Object.keys(base.summaries).length > 0) {
    lines.push("summaries:");
    for (const [k, v] of Object.entries(base.summaries)) lines.push(`  ${k}: ${q(v)}`);
  }
  lines.push("views:");
  for (const v of base.views) {
    lines.push(`  - type: ${q(v.type?.trim() || "table")}`);
    lines.push(`    name: ${q(v.name.trim())}`);
    if (v.filters !== undefined && !isEmptyFilter(v.filters)) {
      emitFilter("    filters:", normalizeFilter(v.filters), "    ", lines);
    }
    if (v.groupBy?.property) {
      lines.push("    groupBy:", `      property: ${q(v.groupBy.property)}`, `      direction: ${v.groupBy.direction ?? "ASC"}`);
    }
    if (v.order?.length) {
      lines.push("    order:");
      for (const p of v.order) lines.push(`      - ${q(p)}`);
    }
    if (v.limit !== undefined) lines.push(`    limit: ${v.limit}`);
    if (v.summaries && Object.keys(v.summaries).length > 0) {
      lines.push("    summaries:");
      for (const [prop, summary] of Object.entries(v.summaries)) lines.push(`      ${prop}: ${q(summary)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Legacy statement arrays are AND-ed; everything else is already a filter. */
function normalizeFilter(f: string[] | ProposedFilter): ProposedFilter {
  return Array.isArray(f) ? { and: f } : f;
}

function isEmptyFilter(f: string[] | ProposedFilter): boolean {
  return Array.isArray(f) && f.length === 0;
}

function validateFilter(f: ProposedFilter): void {
  if (typeof f === "string") {
    if (!f.trim()) throw new Error("Filter statements must be non-empty.");
    return;
  }
  const keys = Object.keys(f);
  if (keys.length !== 1) throw new Error(`A filter group needs exactly one of and/or/not (got ${keys.length ? keys.join(", ") : "none"}).`);
  if (keys[0] !== "and" && keys[0] !== "or" && keys[0] !== "not") {
    throw new Error(`Unknown filter group "${keys[0]}" (use and, or, not).`);
  }
  const [key, children] = groupEntry(f);
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error(`Filter group "${key}" needs at least one child filter.`);
  }
  for (const child of children) validateFilter(child);
}

function groupEntry(f: Exclude<ProposedFilter, string>): ["and" | "or" | "not", ProposedFilter[]] {
  if ("and" in f) return ["and", f.and];
  if ("or" in f) return ["or", f.or];
  return ["not", f.not];
}

/** Emit `header` then the filter — inline for a lone statement, nested for groups. */
function emitFilter(header: string, f: ProposedFilter, indent: string, lines: string[]): void {
  if (typeof f === "string") {
    lines.push(`${header} ${q(f)}`);
    return;
  }
  lines.push(header);
  emitFilterNode(f, `${indent}  `, lines, false);
}

function emitFilterNode(f: ProposedFilter, indent: string, lines: string[], asListItem: boolean): void {
  const marker = asListItem ? "- " : "";
  if (typeof f === "string") {
    lines.push(`${indent}${marker}${q(f)}`);
    return;
  }
  const [key, children] = groupEntry(f);
  lines.push(`${indent}${marker}${key}:`);
  const childIndent = indent + (asListItem ? "    " : "  ");
  for (const child of children) emitFilterNode(child, childIndent, lines, true);
}

/** Quote a YAML scalar only when needed (JSON string quoting is valid YAML). */
function q(s: string): string {
  if (/^[\p{L}\p{N}][\p{L}\p{N} ._/()-]*$/u.test(s) && !/^(true|false|null|yes|no)$/i.test(s)) return s;
  return JSON.stringify(s);
}
