import type { FieldValue, SourceTypeSchema } from "./types";

/** Pull the first JSON object out of a model reply (handles ```json fences + prose). */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence && fence[1] !== undefined) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in reply");
  return JSON.parse(s.slice(start, end + 1));
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value: Record<string, FieldValue>;
}

/** Stringify only primitives; non-primitives (objects/arrays) yield undefined so they're dropped. */
function scalarString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return undefined;
}

function coerce(type: string, raw: unknown): FieldValue | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (type === "string[]") {
    if (!Array.isArray(raw)) return undefined;
    const arr = raw.map((x) => (scalarString(x) ?? "").trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  }
  if (type === "number") {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
    const str = scalarString(raw);
    if (str === undefined) return undefined;
    const n = Number(str.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  const s = scalarString(raw);
  return s === undefined ? undefined : s.trim();
}

/** Validate a model reply against the schema's MODEL-sourced fields only. */
export function validateAgainstSchema(obj: unknown, schema: SourceTypeSchema): ValidationResult {
  const errors: string[] = [];
  const value: Record<string, FieldValue> = {};
  const src = (obj ?? {}) as Record<string, unknown>;
  for (const field of schema.fields) {
    if (field.source !== "model") continue;
    const coerced = coerce(field.type, src[field.key]);
    if (coerced === undefined) {
      if (field.required) errors.push(`missing required field "${field.key}"`);
      continue;
    }
    value[field.key] = coerced;
  }
  return { ok: errors.length === 0, errors, value };
}
