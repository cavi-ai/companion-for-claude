// The JSON value a model reply carries: bare JSON, a ```json fence, or JSON
// wrapped in prose. One reader for every model call that asks for JSON instead
// of a schema-constrained response. Pure.

/** Balanced-bracket scans tried per reply; bounds the work on long prose. */
const MAX_SPAN_STARTS = 16;

/** The bracketed span starting at `start`, honoring JSON strings, or null when it never closes. */
function balancedSpan(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Candidate JSON texts, most likely first: the whole reply, each fenced block, then bracketed spans. */
function* candidates(raw: string): Generator<string> {
  const trimmed = raw.trim();
  yield trimmed;
  for (const m of trimmed.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)) yield m[1]!.trim();
  let starts = 0;
  for (let i = 0; i < trimmed.length && starts < MAX_SPAN_STARTS; i++) {
    if (trimmed[i] !== "{" && trimmed[i] !== "[") continue;
    starts++;
    const span = balancedSpan(trimmed, i);
    if (span !== null) yield span;
  }
}

/** The first JSON value in a model reply that `accept` takes, or undefined when none does. */
export function replyJson(raw: string, accept: (value: unknown) => boolean = () => true): unknown {
  for (const text of candidates(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (accept(value)) return value;
  }
  return undefined;
}
