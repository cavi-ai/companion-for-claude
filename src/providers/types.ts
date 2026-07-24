// Provider abstraction: a uniform interface over Claude (Anthropic API) and
// local models (Ollama). Lets the plugin route cheap/bulk work (summarizing,
// tagging, ingestion) to a local model while reserving Claude for high-value
// reasoning — without the rest of the app caring which backend answered.

import type { ChatMessage, StreamHandlers } from "../types";

export type ProviderId = "anthropic" | "ollama";

/** A role describes *what* a request is for, so the router can pick a backend. */
export type TaskRole = "chat" | "utility";

// ----- content blocks (Anthropic tool-use wire format) -----

export interface TextBlock {
  type: "text";
  text: string;
}

/** A tool invocation requested by the model (from a `tool_use` content block). */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the streamed input JSON failed to parse — executor should return is_error. */
  parseError?: string;
}

/** The outcome of one tool call, sent back in the next user message. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Base64-embedded media source (images and PDFs). */
export interface Base64Source {
  type: "base64";
  media_type: string;
  data: string;
}

export interface ImageBlock {
  type: "image";
  source: Base64Source;
}

/** A PDF attached to a user turn. */
export interface DocumentBlock {
  type: "document";
  source: Base64Source;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | DocumentBlock;

/**
 * A message as sent to a provider. `content` is a plain string for ordinary
 * turns, or content blocks during an agent (tool-use) exchange. `ChatMessage`
 * is assignable, so existing call sites pass through unchanged.
 */
export interface ApiMessage {
  role: ChatMessage["role"];
  content: string | ContentBlock[];
}

/** Flatten a message's content to plain text (for backends without tool use). */
export function textContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** A tool definition in the Anthropic Messages API shape. */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompletionRequest {
  system: string;
  messages: ApiMessage[];
  /** Tools offered to the model (Anthropic only; ignored by other providers). */
  tools?: AnthropicToolDef[];
  model: string;
  maxTokens: number;
  signal?: AbortSignal;
  /** Lower = more deterministic. Used for utility tasks like tagging. */
  temperature?: number;
  /** Request a structured JSON response when the provider supports it. */
  responseFormat?: "json";
  /** JSON Schema supplied to local providers that support constrained output. */
  responseSchema?: Record<string, unknown>;
  /** Extended-thinking config for the request body (model-aware; built by chatControls). */
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  /** Whether to request summarized reasoning text (adaptive models). */
  thinkingDisplay?: "summarized" | "omitted";
  /** `output_config` (currently just `effort`) for models that support it. */
  outputConfig?: { effort: string };
}

export interface ProviderStatus {
  ok: boolean;
  /** Human-readable detail (model list, error, etc.). */
  detail: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** True if the provider has what it needs to run (key / reachable host). */
  hasCredentials(): boolean;
  /** Stream a completion, calling handlers as text arrives. */
  stream(req: CompletionRequest, handlers: StreamHandlers): Promise<void>;
  /** Buffered completion. */
  complete(req: CompletionRequest): Promise<string>;
  /** Lightweight reachability / auth check for the settings "Test" button. */
  test(): Promise<ProviderStatus>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
