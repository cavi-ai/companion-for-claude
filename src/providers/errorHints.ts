// Map a raw provider error message to an actionable hint. Pure + testable.

export type ErrorHintProvider = "anthropic" | "ollama";

export function errorHint(message: string, provider: ErrorHintProvider = "anthropic"): string | null {
  const m = message.toLowerCase();
  if (m.includes("401") || m.includes("invalid api key") || m.includes("authentication")) {
    return "Open Settings → Companion for Claude and check your Anthropic API key. Keys start with “sk-ant-”.";
  }
  if (m.includes("529") || m.includes("overloaded")) {
    return "Anthropic is overloaded (HTTP 529) — a temporary condition on their side. Wait a moment and retry.";
  }
  if (m.includes("429") || m.includes("rate_limit") || m.includes("rate limit") || m.includes("too many requests")) {
    return "Rate limited (HTTP 429). Wait a moment and retry. On a subscription OAuth token this can also mean a per-minute/usage cap on your plan — it does not necessarily mean your API credits are exhausted.";
  }
  if (m.includes("credit") || m.includes("billing") || m.includes("quota")) {
    return "This looks like a billing/credit issue. Add credits in the Anthropic console.";
  }
  // Network-level failures read completely differently depending on which
  // provider was being called: for Ollama the fix is starting the server; for
  // Anthropic it almost always means the machine is offline.
  if (provider === "ollama" && (m.includes("ollama") || m.includes("11434") || m.includes("econnrefused") || m.includes("fetch failed") || m.includes("failed to fetch"))) {
    return "Can’t reach the local model. Run `ollama serve`, then verify the host in settings (default http://localhost:11434).";
  }
  if (provider === "anthropic" && (m.includes("fetch failed") || m.includes("failed to fetch") || m.includes("econnrefused") || m.includes("network"))) {
    return "Can’t reach Anthropic — you appear to be offline. Check your connection. With a local model configured, the “Auto” chat backend keeps chat working offline.";
  }
  // Deliberately last: "model" is a broad substring and must not shadow the
  // specific cases above.
  if (m.includes("not_found") || m.includes("404") || m.includes("model")) {
    return "That model id may be wrong. Pick one from the dropdown, or clear the custom-model field.";
  }
  return null;
}
