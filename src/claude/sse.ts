// Pure (Obsidian-free) parsing of Anthropic streaming responses, extracted so
// it can be unit-tested without a browser/Electron runtime.

export interface SseEvent {
  type: string;
  // `stop_reason` rides on the message_delta event's delta (e.g. "max_tokens").
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  error?: { message?: string };
  // Usage appears on message_start (input/cache tokens) and message_delta (output).
  message?: { usage?: TokenUsage };
  usage?: TokenUsage;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SseParseResult {
  /** Concatenated text deltas found in the consumed lines. */
  text: string;
  /** Concatenated extended-thinking deltas (thinking_delta) in the consumed lines. */
  thinking: string;
  /** The unconsumed trailing remainder (an incomplete final line). */
  remainder: string;
  /** Set if an `error` event was encountered. */
  error?: string;
  /** Token usage seen in this chunk, merged across events. */
  usage?: TokenUsage;
  /** Why generation stopped, if reported (e.g. "max_tokens" = truncated). */
  stopReason?: string;
}

/**
 * Consume whole lines from an SSE `buffer`, returning any text deltas and the
 * leftover partial line. Call repeatedly as chunks arrive, feeding the previous
 * `remainder` back in.
 */
export function parseSseChunk(buffer: string): SseParseResult {
  let text = "";
  let thinking = "";
  let error: string | undefined;
  let usage: TokenUsage | undefined;
  let stopReason: string | undefined;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]" || payload.length === 0) continue;
    let evt: SseEvent;
    try {
      evt = JSON.parse(payload) as SseEvent;
    } catch {
      continue; // ignore malformed keep-alive/partial lines
    }
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
      text += evt.delta.text;
    } else if (evt.type === "content_block_delta" && evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
      thinking += evt.delta.thinking;
    } else if (evt.type === "error") {
      error = evt.error?.message ?? "Streaming error from Anthropic API";
    }
    if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
    // Merge any usage carried on this event (message_start / message_delta).
    const u = evt.message?.usage ?? evt.usage;
    if (u) usage = mergeUsage(usage, u);
  }
  return {
    text,
    thinking,
    remainder: buffer,
    ...(error !== undefined ? { error } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

/** Merge two partial usage records, preferring later non-undefined values. */
export function mergeUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  const merged: TokenUsage = {};
  const input = b.input_tokens ?? a?.input_tokens;
  const output = b.output_tokens ?? a?.output_tokens;
  const cacheRead = b.cache_read_input_tokens ?? a?.cache_read_input_tokens;
  const cacheCreation = b.cache_creation_input_tokens ?? a?.cache_creation_input_tokens;
  if (input !== undefined) merged.input_tokens = input;
  if (output !== undefined) merged.output_tokens = output;
  if (cacheRead !== undefined) merged.cache_read_input_tokens = cacheRead;
  if (cacheCreation !== undefined) merged.cache_creation_input_tokens = cacheCreation;
  return merged;
}

/** Turn an Anthropic error response body + status into a readable message. */
export function extractApiError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return `Anthropic API ${status}: ${parsed.error.message}`;
  } catch {
    /* not JSON */
  }
  if (status === 401) return "Anthropic API 401: invalid API key.";
  if (status === 429) return "Anthropic API 429: rate limited — slow down or check your plan.";
  return `Anthropic API error ${status}.`;
}
