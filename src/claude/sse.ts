// Pure (Obsidian-free) parsing of Anthropic streaming responses, extracted so
// it can be unit-tested without a browser/Electron runtime.

import type { ToolUseBlock } from "../providers/types";

export interface SseEvent {
  type: string;
  // `stop_reason` rides on the message_delta event's delta (e.g. "max_tokens").
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string; partial_json?: string };
  error?: { message?: string };
  // Usage appears on message_start (input/cache tokens) and message_delta (output).
  message?: { usage?: TokenUsage };
  usage?: TokenUsage;
  // Content-block events (tool use) carry the block index and, on start, the block.
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
}

/** A tool_use block still being streamed (input JSON arrives in fragments). */
interface OpenToolBlock {
  id: string;
  name: string;
  jsonBuf: string;
}

/**
 * Parser state for content blocks that span chunk boundaries. Thread the
 * returned state back into the next `parseSseChunk` call (like `remainder`).
 */
export interface SseBlockState {
  open: Record<number, OpenToolBlock>;
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
  /** Why generation stopped, if reported (e.g. "max_tokens" = truncated, "tool_use"). */
  stopReason?: string;
  /** tool_use blocks completed in the consumed lines, in completion order. */
  toolUses: ToolUseBlock[];
  /** Open-block state to thread into the next call. */
  state: SseBlockState;
}

/**
 * Consume whole lines from an SSE `buffer`, returning any text deltas and the
 * leftover partial line. Call repeatedly as chunks arrive, feeding the previous
 * `remainder` (and, for tool-use streams, `state`) back in.
 */
export function parseSseChunk(buffer: string, state: SseBlockState = { open: {} }): SseParseResult {
  let text = "";
  let thinking = "";
  let error: string | undefined;
  let usage: TokenUsage | undefined;
  let stopReason: string | undefined;
  const toolUses: ToolUseBlock[] = [];
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
    } else if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta" && evt.index !== undefined) {
      const open = state.open[evt.index];
      if (open) open.jsonBuf += evt.delta.partial_json ?? "";
    } else if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use" && evt.index !== undefined) {
      state.open[evt.index] = { id: evt.content_block.id ?? "", name: evt.content_block.name ?? "", jsonBuf: "" };
    } else if (evt.type === "content_block_stop" && evt.index !== undefined && state.open[evt.index]) {
      const open = state.open[evt.index];
      if (open) toolUses.push(finalizeToolBlock(open));
      delete state.open[evt.index];
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
    toolUses,
    state,
    ...(error !== undefined ? { error } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

/** Parse an open block's accumulated input JSON; a parse failure becomes `parseError`. */
function finalizeToolBlock(open: OpenToolBlock): ToolUseBlock {
  const block: ToolUseBlock = { type: "tool_use", id: open.id, name: open.name, input: {} };
  const raw = open.jsonBuf.trim();
  if (raw.length === 0) return block;
  try {
    block.input = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    block.parseError = `Tool input was not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  return block;
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
