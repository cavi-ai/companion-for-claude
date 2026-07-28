// One shared "complete → parse → repair once" loop for schema-bound JSON
// completions. The research draft and revision coordinators ran identical
// copies of this; extract.ts keeps its own multi-error variant.

import type { CompletionRequest, Provider } from "./types";

export interface RepairedCompletion<T> {
  /** The raw text that parsed successfully (the repair reply when repaired). */
  raw: string;
  response: T;
  /** True when the first reply failed to parse and the repair retry succeeded. */
  repaired: boolean;
}

/**
 * Run a completion and parse the reply. On a parse failure, retry once with
 * the assistant's bad reply echoed back plus a repair instruction; a second
 * parse failure throws (callers with a deterministic fallback catch it).
 */
export async function completeJsonWithRepair<T>(
  provider: Provider,
  completion: CompletionRequest,
  parse: (raw: string) => T,
): Promise<RepairedCompletion<T>> {
  let raw = await provider.complete(completion);
  try {
    return { raw, response: parse(raw), repaired: false };
  } catch (error) {
    const feedback = error instanceof Error ? error.message : "The response did not match the required schema";
    raw = await provider.complete({
      ...completion,
      messages: [
        ...completion.messages,
        { role: "assistant", content: raw },
        { role: "user", content: `Your previous JSON was rejected: ${feedback}. Return one complete corrected JSON object matching responseSchema.` },
      ],
    });
    return { raw, response: parse(raw), repaired: true };
  }
}
