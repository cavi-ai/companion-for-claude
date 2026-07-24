// Conformance checking (spec 2026-07-08 §4): always advisory, never blocking.
// Given a note's frontmatter and its resolved type, report issues and apply
// safe auto-fixes (list-wrapping, numeric coercion). Pure.

import { ROOT_TYPE } from "./types";
import type { PropertyDef, ResolvedType } from "./types";
import { relationTargets } from "./relations";

export type IssueKind = "unknown-type" | "missing-required" | "unknown-key" | "wrong-type" | "bad-relation-target";

export interface ConformanceIssue {
  kind: IssueKind;
  key?: string | undefined;
  message: string;
}

export interface ConformanceResult {
  /** True when no issues remain after auto-fixes. */
  ok: boolean;
  issues: ConformanceIssue[];
  /** Frontmatter with auto-fixes applied (input is never mutated). */
  fixed: Record<string, unknown>;
}

/** Keys every note may carry regardless of type. */
export const BASE_KEYS: ReadonlySet<string> = new Set([
  "type", "title", "created", "source", "tags", "summary", "aliases", "cssclasses",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function checkProperty(p: PropertyDef, value: unknown, fixed: Record<string, unknown>, issues: ConformanceIssue[]): void {
  switch (p.type) {
    case "string[]":
      if (typeof value === "string") fixed[p.key] = [value];
      else if (!Array.isArray(value)) issues.push({ kind: "wrong-type", key: p.key, message: `'${p.key}' should be a list` });
      else if (value.some((x) => typeof x !== "string")) issues.push({ kind: "wrong-type", key: p.key, message: `'${p.key}' should be a list of text values` });
      return;
    case "number":
      if (typeof value === "number") return;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) fixed[p.key] = Number(value);
      else issues.push({ kind: "wrong-type", key: p.key, message: `'${p.key}' should be a number` });
      return;
    case "boolean":
      if (typeof value !== "boolean") issues.push({ kind: "wrong-type", key: p.key, message: `'${p.key}' should be true or false` });
      return;
    case "date":
      if (typeof value !== "string" || !DATE_RE.test(value)) issues.push({ kind: "wrong-type", key: p.key, message: `'${p.key}' should be a YYYY-MM-DD date` });
      return;
    default: // string, duration — any scalar string is fine
      if (typeof value !== "string" && typeof value !== "number") issues.push({ kind: "wrong-type", key: p.key, message: `'${p.key}' should be text` });
  }
}

/**
 * Check `frontmatter` against `type`. `lookupType` resolves a relation target
 * (basename/path as written) to that note's ResolvedType; return undefined for
 * dangling or untyped targets — those are allowed.
 */
export function conform(
  frontmatter: Record<string, unknown>,
  type: ResolvedType | undefined,
  lookupType: (target: string) => ResolvedType | undefined,
): ConformanceResult {
  const fixed: Record<string, unknown> = { ...frontmatter };
  const issues: ConformanceIssue[] = [];

  if (!type) {
    const typeName = typeof frontmatter.type === "string" ? frontmatter.type : "";
    issues.push({ kind: "unknown-type", key: "type", message: `unknown type '${typeName}'` });
    return { ok: false, issues, fixed };
  }

  const propKeys = new Map(type.properties.map((p) => [p.key, p]));
  const relKeys = new Map(type.relations.map((r) => [r.key, r]));

  for (const p of type.properties) {
    const v = fixed[p.key];
    if (v === undefined || v === null || v === "") {
      if (p.required) issues.push({ kind: "missing-required", key: p.key, message: `missing required property '${p.key}'` });
      continue;
    }
    checkProperty(p, v, fixed, issues);
  }

  for (const r of type.relations) {
    const v = fixed[r.key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") fixed[r.key] = [v]; // relations are always lists
    else if (!Array.isArray(v)) {
      issues.push({ kind: "wrong-type", key: r.key, message: `'${r.key}' should be a list of "[[wikilinks]]"` });
      continue;
    } else if (v.some((x) => typeof x !== "string")) {
      // Flag the mixed array, but still check the string targets it does have.
      issues.push({ kind: "wrong-type", key: r.key, message: `'${r.key}' should be a list of "[[wikilink]]" strings only` });
    }
    for (const target of relationTargets(fixed[r.key])) {
      const targetType = lookupType(target);
      if (!targetType) continue; // dangling/untyped: allowed
      const allowed = r.targets.includes(ROOT_TYPE) || r.targets.some((t) => targetType.lineage.includes(t));
      if (!allowed) {
        issues.push({ kind: "bad-relation-target", key: r.key, message: `'${r.key}' → '${target}' is a ${targetType.name}, expected ${r.targets.join("|")}` });
      }
    }
  }

  for (const key of Object.keys(fixed)) {
    if (!BASE_KEYS.has(key) && !propKeys.has(key) && !relKeys.has(key)) {
      issues.push({ kind: "unknown-key", key, message: `'${key}' is not declared on type '${type.name}'` });
    }
  }

  return { ok: issues.length === 0, issues, fixed };
}
