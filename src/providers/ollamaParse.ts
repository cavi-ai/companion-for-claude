// Pure parser for a single line of Ollama's NDJSON streaming response.
// Each line is a standalone JSON object like:
//   {"message":{"role":"assistant","content":"Hel"},"done":false}
//   {"done":true,...}
// Extracted so it can be unit-tested without a running Ollama.

export interface OllamaLineResult {
  text: string;
  done: boolean;
  error?: string;
}

export function parseOllamaLine(line: string): OllamaLineResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { text: "", done: false };
  let obj: { message?: { content?: string }; done?: boolean; error?: string };
  try {
    obj = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean; error?: string };
  } catch {
    return { text: "", done: false }; // ignore partials / keep-alives
  }
  if (obj.error) return { text: "", done: true, error: obj.error };
  return { text: obj.message?.content ?? "", done: obj.done === true };
}
