import type { FieldValue, SourceTypeSchema } from "./types";
import { extractJson, validateAgainstSchema } from "./validate";

export class ExtractError extends Error {
  constructor(readonly errors: string[]) {
    super(`extraction failed: ${errors.join("; ")}`);
    this.name = "ExtractError";
  }
}

export interface ExtractCompletionOpts {
  /** Extraction needs room for 10+ fields; the shared utility default (1024) truncates long replies. */
  maxTokens?: number;
  /** JSON Schema for constrained local decoding (Ollama `format`). */
  responseSchema?: Record<string, unknown>;
  /** Thinking models otherwise spend the whole budget on reasoning and reply empty. */
  disableThinking?: boolean;
}

export interface ExtractDeps {
  complete: (system: string, user: string, opts?: ExtractCompletionOpts) => Promise<string>;
}

const MAX_CONTENT = 8000;
const EXTRACT_MAX_TOKENS = 4096;

/** JSON Schema for the asked model fields (constrained local decoding). */
export function extractionJsonSchema(asked: SourceTypeSchema["fields"]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of asked) {
    properties[f.key] =
      f.type === "string[]"
        ? { type: ["array", "null"], items: { type: "string" } }
        : f.type === "number"
          ? { type: ["number", "null"] }
          : { type: ["string", "null"] };
    if (f.required) required.push(f.key);
  }
  return { type: "object", properties, required };
}

function buildSystem(schema: SourceTypeSchema, asked: SourceTypeSchema["fields"]): string {
  const lines = asked.map((f) => `- ${f.key} (${f.type}${f.required ? ", required" : ""}): ${f.description}`);
  return (
    "You extract structured metadata from a source document. " +
    "Reply with a SINGLE JSON object and nothing else. Use EXACTLY these keys:\n" +
    lines.join("\n") +
    "\nRules: required keys must be present and non-empty. For list types return a JSON array of short strings. " +
    "Use null for any optional value you cannot determine. Do not invent facts. Return only the JSON object."
  );
}

/** A schema with the model fields the caller already has (prefilled) removed. */
function reducedSchema(schema: SourceTypeSchema, prefilled: Record<string, FieldValue>): SourceTypeSchema {
  return { ...schema, fields: schema.fields.filter((f) => f.source !== "model" || !(f.key in prefilled)) };
}

/**
 * Extract model fields (validated, with a repair loop) and merge derived and
 * prefilled fields in. `prefilled` holds model-sourced values the capture
 * already carries (e.g. stamped by the Web Clipper from page metadata) — those
 * keys are neither asked of the model nor overwritten by it.
 */
export async function extractFields(
  schema: SourceTypeSchema,
  content: string,
  derived: Record<string, FieldValue>,
  deps: ExtractDeps,
  maxRepairs = 2,
  prefilled: Record<string, FieldValue> = {},
): Promise<{ fields: Record<string, FieldValue> }> {
  const reduced = reducedSchema(schema, prefilled);
  const asked = reduced.fields.filter((f) => f.source === "model");
  if (asked.length === 0) return { fields: { ...prefilled, ...derived } };
  const system = buildSystem(reduced, asked);
  const base = `SOURCE CONTENT:\n\n${content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) + "\n…[truncated]" : content}`;
  const opts: ExtractCompletionOpts = { maxTokens: EXTRACT_MAX_TOKENS, responseSchema: extractionJsonSchema(asked), disableThinking: true };
  let lastErrors: string[] = ["no reply"];

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const user = attempt === 0 ? base : `${base}\n\nYour previous reply was invalid: ${lastErrors.join("; ")}. Return corrected JSON only.`;
    const raw = await deps.complete(system, user, opts);
    let obj: unknown;
    try {
      obj = extractJson(raw);
    } catch {
      lastErrors = ["reply was not valid JSON"];
      continue;
    }
    const res = validateAgainstSchema(obj, reduced);
    if (res.ok) return { fields: { ...prefilled, ...res.value, ...derived } };
    lastErrors = res.errors;
  }
  throw new ExtractError(lastErrors);
}
