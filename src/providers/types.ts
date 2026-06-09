// Provider abstraction: a uniform interface over Claude (Anthropic API) and
// local models (Ollama). Lets the plugin route cheap/bulk work (summarizing,
// tagging, ingestion) to a local model while reserving Claude for high-value
// reasoning — without the rest of the app caring which backend answered.

import type { ChatMessage, StreamHandlers } from "../types";

export type ProviderId = "anthropic" | "ollama";

/** A role describes *what* a request is for, so the router can pick a backend. */
export type TaskRole = "chat" | "utility";

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
  signal?: AbortSignal;
  /** Lower = more deterministic. Used for utility tasks like tagging. */
  temperature?: number;
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
