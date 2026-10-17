// Carries a JSON request's response schema to a provider that cannot constrain output natively.

import type { CompletionRequest } from "./types";

/** The system prompt plus the JSON Schema the reply must match; unchanged for a request without one. */
export function systemWithSchema(req: Pick<CompletionRequest, "system" | "responseFormat" | "responseSchema">): string {
  if (req.responseFormat !== "json" || !req.responseSchema) return req.system;
  const rule = `Reply with one JSON object that matches this JSON Schema:\n${JSON.stringify(req.responseSchema)}`;
  return req.system ? `${req.system}\n\n${rule}` : rule;
}
