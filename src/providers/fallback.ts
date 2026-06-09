// Pure (Obsidian-free) fallback policy: decides when a failed Claude request
// should transparently retry on the local model, so you keep working on a plane
// or when tokens run out. The router/ChatView own the wiring; this owns the
// decision and stays unit-testable.

export type ChatBackend = "claude" | "local" | "auto";

/**
 * Classify an error as one where falling back to a local model makes sense:
 * network loss, rate limit / usage caps, auth failure, or server outage.
 * A genuine bad-request (400) is the user's prompt/params and won't be helped
 * by switching models, so it does not trigger fallback.
 */
export function isOfflineOrUsageError(err: { message?: string; status?: number } | null | undefined): boolean {
  if (!err) return false;
  const status = err.status;
  if (status === 429 || status === 401 || status === 403 || (status !== undefined && status >= 500)) return true;
  const m = (err.message ?? "").toLowerCase();
  return (
    m.includes("rate") ||
    m.includes("429") ||
    m.includes("usage") ||
    m.includes("quota") ||
    m.includes("credit") ||
    m.includes("overloaded") ||
    m.includes("fetch failed") ||
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("econnrefused") ||
    m.includes("enotfound") ||
    m.includes("etimedout") ||
    m.includes("timeout") ||
    m.includes("offline") ||
    m.includes("err_internet") ||
    m.includes("getaddrinfo") ||
    m.includes("socket")
  );
}

export interface FallbackContext {
  backend: ChatBackend;
  /** A usable local (Ollama) model is configured + reachable. */
  localAvailable: boolean;
  /** The error the primary Claude request failed with. */
  error: { message?: string; status?: number } | null | undefined;
}

/**
 * Decide whether to retry the request on the local model after Claude failed.
 * - "local": the request already ran locally — never fall back again.
 * - "claude": only fall back to keep you working when the error is an
 *   offline/usage failure (an explicit Claude-only choice still degrades
 *   gracefully rather than dead-ending).
 * - "auto": fall back on any offline/usage failure (this is the point of auto).
 * Always requires a local model to actually be available.
 */
export function shouldFallbackToLocal(ctx: FallbackContext): boolean {
  if (ctx.backend === "local") return false;
  if (!ctx.localAvailable) return false;
  return isOfflineOrUsageError(ctx.error);
}

/** Which provider a turn should *start* on, given the backend mode. */
export function primaryBackend(backend: ChatBackend): "claude" | "local" {
  // "local" starts local; "claude" and "auto" start on Claude (auto degrades
  // to local only on failure).
  return backend === "local" ? "local" : "claude";
}

/** A short, user-facing reason for a fallback, derived from the error. */
export function fallbackReason(err: { message?: string; status?: number } | null | undefined): string {
  const status = err?.status;
  const m = (err?.message ?? "").toLowerCase();
  if (status === 429 || m.includes("rate") || m.includes("usage") || m.includes("quota") || m.includes("credit")) {
    return "Claude is rate-limited or out of usage";
  }
  if (status === 401 || status === 403 || m.includes("auth")) return "Claude credential rejected";
  if (m.includes("fetch") || m.includes("network") || m.includes("offline") || m.includes("econnrefused") || m.includes("getaddrinfo")) {
    return "No connection to Claude";
  }
  if (status !== undefined && status >= 500) return "Claude service error";
  return "Claude unavailable";
}
