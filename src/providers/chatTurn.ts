// One chat turn's backend routing (primary attempt, a partial agent answer kept, local fallback) and one
// streaming attempt settled as a turn result. Pure; providers and request building are injected.

import type { AgentTurnHandlers, AgentTurnResult } from "../agent/loop";
import type { ErrorHintProvider } from "./errorHints";
import { fallbackReason, shouldFallbackToLocal, type ChatBackend } from "./fallback";
import type { CompletionRequest, Provider } from "./types";

/**
 * One streaming completion as a turn result. Settles exactly once — on done, error, abort, or a stream
 * that resolves without either — keeping the text received so far; never rejects.
 */
export function streamAttempt(provider: Pick<Provider, "stream">, request: CompletionRequest, handlers: AgentTurnHandlers, signal: AbortSignal): Promise<AgentTurnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (result: AgentTurnResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ text: buffer, trace: [], aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    const fail = (error: unknown): void => {
      if (settled) return;
      const status = (error as { status?: number } | null)?.status;
      const err = error instanceof Error ? error : new Error(String(error));
      if (status !== undefined) (err as Error & { status?: number }).status = status;
      finish({ text: buffer, trace: [], error: err });
    };
    void provider.stream(request, {
      onThinking: (delta) => handlers.onThinking?.(delta),
      onText: (delta) => {
        if (settled) return;
        buffer += delta;
        handlers.onText(delta);
      },
      onError: (err) => fail(err),
      onUsage: (usage) => handlers.onUsage?.(usage),
      onTruncated: () => handlers.onTruncated?.(),
      onDone: (full) => finish({ text: full, trace: [] }),
    }).then(() => finish({ text: buffer, trace: [], aborted: true })).catch((error: unknown) => fail(error));
  });
}

export interface TurnRoute {
  backend: ChatBackend;
  /** Agent turns (vault tools or a CLI backend) keep a partial answer instead of falling back. */
  agent: boolean;
  /** The provider the primary attempt runs on, named on its error for the hint. */
  providerId: ErrorHintProvider;
}

export interface TurnAttempts<F extends { provider: Pick<Provider, "id">; model: string }> {
  primary(): Promise<AgentTurnResult>;
  /** A reachable local model, or null. */
  localFallback(): Promise<F | null>;
  local(fallback: F): Promise<AgentTurnResult>;
}

/**
 * Run the primary attempt; on error, an agent turn that already produced text or tool calls ends as an
 * answer with a notice, and anything else may retry on a local model when the fallback policy allows.
 * A failed result's error names the provider it failed on.
 */
export async function routeTurn<F extends { provider: Pick<Provider, "id">; model: string }>(route: TurnRoute, attempts: TurnAttempts<F>, handlers: Pick<AgentTurnHandlers, "onNotice">): Promise<AgentTurnResult> {
  const primary = await attempts.primary();
  if (!primary.error) return primary;
  if (route.agent && (primary.text.trim().length > 0 || primary.trace.length > 0)) {
    handlers.onNotice?.(`Turn ended early: ${primary.error.message}`);
    return { text: primary.text, trace: primary.trace, ...(primary.aborted !== undefined ? { aborted: primary.aborted } : {}), ...(primary.capped !== undefined ? { capped: primary.capped } : {}) };
  }
  if (route.backend === "device") return tagged(primary, "device");
  const fallback = await attempts.localFallback();
  if (!fallback || !shouldFallbackToLocal({ backend: route.backend, localAvailable: true, error: primary.error })) return tagged(primary, route.providerId);
  handlers.onNotice?.(`${fallbackReason(primary.error)} — answered locally with ${fallback.model}.`);
  const result = await attempts.local(fallback);
  return result.error ? tagged(result, fallback.provider.id) : result;
}

function tagged(result: AgentTurnResult, provider: ErrorHintProvider): AgentTurnResult {
  if (result.error) (result.error as Error & { ccProvider?: ErrorHintProvider }).ccProvider = provider;
  return result;
}
