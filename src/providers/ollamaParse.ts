// Pure parser for a single line of Ollama's NDJSON streaming response.
// Each line is a standalone JSON object like:
//   {"message":{"role":"assistant","content":"Hel"},"done":false}
//   {"done":true,...}
// Extracted so it can be unit-tested without a running Ollama.

export interface OllamaToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface OllamaLineResult {
  text: string;
  done: boolean;
  error?: string;
  /** Function calls the model asked for (arrive in final chunks on tool-capable models). */
  toolCalls?: OllamaToolCall[];
}

export function parseOllamaLine(line: string): OllamaLineResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { text: "", done: false };
  let obj: {
    message?: { content?: string; tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> };
    done?: boolean;
    error?: string;
  };
  try {
    obj = JSON.parse(trimmed) as typeof obj;
  } catch {
    return { text: "", done: false }; // ignore partials / keep-alives
  }
  if (obj.error) return { text: "", done: true, error: obj.error };
  const toolCalls = (obj.message?.tool_calls ?? []).flatMap((call): OllamaToolCall[] => {
    const name = call.function?.name;
    if (typeof name !== "string" || !name) return [];
    const args = call.function?.arguments;
    return [{ name, input: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} }];
  });
  return { text: obj.message?.content ?? "", done: obj.done === true, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
}
