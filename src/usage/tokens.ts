// Token + context-window accounting for the chat usage display. Pure/testable.
//
// Real token counts come back from the API (usage events). Before a request,
// we show an *estimate* so users see how full the context window is getting —
// important when paying per token with an API key.

import type { TokenUsage } from "../claude/sse";

export interface ModelLimits {
  /** Total context window (input + output) in tokens. */
  contextWindow: number;
  /** Max output tokens the model can produce. */
  maxOutput: number;
  /** USD per million input / output tokens (approximate, for an at-a-glance cost). */
  inputCostPerM: number;
  outputCostPerM: number;
}

// Approximate public values (verified against Anthropic docs 2026-07-05);
// a custom/unknown model falls back to DEFAULT_LIMITS.
const LIMITS: Record<string, ModelLimits> = {
  "claude-opus-4-8": { contextWindow: 1_000_000, maxOutput: 128_000, inputCostPerM: 5, outputCostPerM: 25 },
  "claude-sonnet-5": { contextWindow: 1_000_000, maxOutput: 128_000, inputCostPerM: 3, outputCostPerM: 15 },
  "claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutput: 128_000, inputCostPerM: 3, outputCostPerM: 15 },
  "claude-haiku-4-5-20251001": { contextWindow: 200_000, maxOutput: 64_000, inputCostPerM: 1, outputCostPerM: 5 },
};

// Prompt-cache pricing relative to the base input rate (5-minute TTL).
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

export const DEFAULT_LIMITS: ModelLimits = { contextWindow: 200_000, maxOutput: 8_000, inputCostPerM: 3, outputCostPerM: 15 };

export function limitsFor(modelId: string): ModelLimits {
  if (LIMITS[modelId]) return LIMITS[modelId];
  // Match by family prefix so dated snapshots resolve (e.g. ...-20250930).
  for (const [id, lim] of Object.entries(LIMITS)) {
    const family = id.replace(/-\d{8}$/, "");
    if (modelId.startsWith(family)) return lim;
  }
  return DEFAULT_LIMITS;
}

/**
 * Rough token estimate from character count (~3.7 chars/token for English
 * prose + markdown). Deliberately conservative — used only for the pre-send
 * gauge, never for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.7);
}

export interface ContextGauge {
  used: number;
  window: number;
  /** 0..1 fraction of the window consumed. */
  fraction: number;
  /** Tokens left for input given the reserved output budget. */
  remaining: number;
}

/** Build the pre-send context gauge from estimated input + reserved output. */
export function contextGauge(estimatedInput: number, modelId: string, reservedOutput: number): ContextGauge {
  const { contextWindow } = limitsFor(modelId);
  const used = estimatedInput + reservedOutput;
  const fraction = Math.min(1, used / contextWindow);
  return { used, window: contextWindow, fraction, remaining: Math.max(0, contextWindow - used) };
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Tokens written to the prompt cache (billed at 1.25× the input rate). */
  cacheWriteTokens: number;
  requests: number;
}

export const EMPTY_SESSION: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };

/** Fold an API usage record into the running session total. */
export function addUsage(session: SessionUsage, u: TokenUsage): SessionUsage {
  return {
    inputTokens: session.inputTokens + (u.input_tokens ?? 0),
    outputTokens: session.outputTokens + (u.output_tokens ?? 0),
    cacheReadTokens: session.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: (session.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    requests: session.requests + 1,
  };
}

/**
 * Approximate session cost in USD for the given model. The API reports
 * `input_tokens` exclusive of cache reads/writes, so each bucket is priced
 * at its own rate: full input, cache writes at 1.25×, cache reads at 0.1×.
 */
export function sessionCost(session: SessionUsage, modelId: string): number {
  const { inputCostPerM, outputCostPerM } = limitsFor(modelId);
  const input = (session.inputTokens / 1_000_000) * inputCostPerM;
  const cacheWrite = ((session.cacheWriteTokens ?? 0) / 1_000_000) * inputCostPerM * CACHE_WRITE_MULT;
  const cacheRead = (session.cacheReadTokens / 1_000_000) * inputCostPerM * CACHE_READ_MULT;
  const output = (session.outputTokens / 1_000_000) * outputCostPerM;
  return input + cacheWrite + cacheRead + output;
}

/** Compact human formatting: 1234 → "1.2k", 1_200_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
