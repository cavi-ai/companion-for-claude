import type { FieldValue, SourceTypeSchema } from "./types";
import { extractJson, validateAgainstSchema } from "./validate";

export class ExtractError extends Error {
  constructor(readonly errors: string[]) {
    super(`extraction failed: ${errors.join("; ")}`);
    this.name = "ExtractError";
  }
}

export interface ExtractDeps {
  complete: (system: string, user: string) => Promise<string>;
}

const MAX_CONTENT = 8000;

function buildSystem(schema: SourceTypeSchema): string {
  const fields = schema.fields.filter((f) => f.source === "model");
  const lines = fields.map((f) => `- ${f.key} (${f.type}${f.required ? ", required" : ""}): ${f.description}`);
  return (
    "You extract structured metadata from a source document. " +
    "Reply with a SINGLE JSON object and nothing else. Use EXACTLY these keys:\n" +
    lines.join("\n") +
    "\nRules: required keys must be present and non-empty. For list types return a JSON array of short strings. " +
    "Use null for any optional value you cannot determine. Do not invent facts. Return only the JSON object."
  );
}

/** Extract model fields (validated, with a repair loop) and merge derived fields in. */
export async function extractFields(
  schema: SourceTypeSchema,
  content: string,
  derived: Record<string, FieldValue>,
  deps: ExtractDeps,
  maxRepairs = 2,
): Promise<{ fields: Record<string, FieldValue> }> {
  const system = buildSystem(schema);
  const base = `SOURCE CONTENT:\n\n${content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) + "\n…[truncated]" : content}`;
  let lastErrors: string[] = ["no reply"];

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const user = attempt === 0 ? base : `${base}\n\nYour previous reply was invalid: ${lastErrors.join("; ")}. Return corrected JSON only.`;
    const raw = await deps.complete(system, user);
    let obj: unknown;
    try {
      obj = extractJson(raw);
    } catch {
      lastErrors = ["reply was not valid JSON"];
      continue;
    }
    const res = validateAgainstSchema(obj, schema);
    if (res.ok) return { fields: { ...res.value, ...derived } };
    lastErrors = res.errors;
  }
  throw new ExtractError(lastErrors);
}
