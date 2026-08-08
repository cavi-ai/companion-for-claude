// Map a raw provider error message to an actionable hint. Pure + testable.

import { sanitizeEndpointForDisplay } from "./endpointPolicy";

export type ErrorHintProvider = "anthropic" | "ollama" | "openai-compat";

function redactUrlUserinfo(message: string): string {
  return message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi, "$1");
}

function endpointName(provider: ErrorHintProvider, endpoint?: string): string {
  const safeEndpoint = endpoint?.trim() ? sanitizeEndpointForDisplay(endpoint) : "";
  const at = safeEndpoint ? ` at ${safeEndpoint}` : "";
  if (provider === "ollama") return `Ollama${at}`;
  if (provider === "openai-compat") return `the OpenAI-compatible endpoint${at}`;
  return `Anthropic${at}`;
}

export function errorHint(message: string, provider: ErrorHintProvider = "anthropic", endpoint?: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("401") || m.includes("invalid api key") || m.includes("authentication")) {
    if (provider !== "anthropic") {
      return `Authentication failed for ${endpointName(provider, endpoint)}. Check its host and API key in Companion settings.`;
    }
    if (endpoint?.trim()) return `Authentication failed for ${endpointName(provider, endpoint)}. Check your Anthropic credential and gateway settings.`;
    return "Open Settings → Companion for Claude and check your Anthropic API key. Keys start with “sk-ant-”.";
  }
  if (m.includes("529") || m.includes("overloaded")) {
    if (provider !== "anthropic") return `${endpointName(provider, endpoint)} is overloaded (HTTP 529). Wait a moment and retry.`;
    return `${endpointName(provider, endpoint)} is overloaded (HTTP 529) — a temporary condition on their side. Wait a moment and retry.`;
  }
  if (m.includes("429") || m.includes("rate_limit") || m.includes("rate limit") || m.includes("too many requests")) {
    if (provider !== "anthropic") return `${endpointName(provider, endpoint)} rate limited this request (HTTP 429). Wait a moment and retry.`;
    return `${endpoint?.trim() ? `${endpointName(provider, endpoint)} rate limited this request` : "Rate limited"} (HTTP 429). Wait a moment and retry. On a subscription OAuth token this can also mean a per-minute/usage cap on your plan — it does not necessarily mean your API credits are exhausted.`;
  }
  if (m.includes("credit") || m.includes("billing") || m.includes("quota")) {
    if (provider !== "anthropic") return `${endpointName(provider, endpoint)} reported a billing, credit, or quota error. Check that endpoint's account settings.`;
    return `${endpoint?.trim() ? `${endpointName(provider, endpoint)} reported a billing/credit issue.` : "This looks like a billing/credit issue."} Add credits in the Anthropic console.`;
  }
  // Network-level failures read completely differently depending on which
  // provider was being called: for Ollama the fix is starting the server; for
  // Anthropic it almost always means the machine is offline.
  if (provider === "ollama" && (m.includes("ollama") || m.includes("11434") || m.includes("econnrefused") || m.includes("fetch failed") || m.includes("failed to fetch"))) {
    const target = endpoint?.trim() || "http://localhost:11434";
    return `Can’t reach the local model (${endpointName(provider, target)}). Run \`ollama serve\`, then verify that host in Companion settings.`;
  }
  if (provider === "openai-compat" && (m.includes("econnrefused") || m.includes("fetch failed") || m.includes("failed to fetch") || m.includes("network"))) {
    return `Can’t reach ${endpointName(provider, endpoint)}. Verify the host, server, and network access in Companion settings.`;
  }
  if (provider === "anthropic" && (m.includes("fetch failed") || m.includes("failed to fetch") || m.includes("econnrefused") || m.includes("network"))) {
    return `Can’t reach ${endpointName(provider, endpoint)} — you appear to be offline. Check your connection. With a local model configured, the “Auto” chat backend keeps chat working offline.`;
  }
  // Deliberately last: "model" is a broad substring and must not shadow the
  // specific cases above.
  if (m.includes("not_found") || m.includes("404") || /\bmodel(?:\s+id)?(?:\s*:|\s+(?:is\s+)?(?:invalid|unknown|not found|missing))/.test(m)) {
    if (provider !== "anthropic") return `The model id may be wrong for ${endpointName(provider, endpoint)}. Check the configured model and endpoint.`;
    return `${endpoint?.trim() ? `The model id may be wrong for ${endpointName(provider, endpoint)}.` : "That model id may be wrong."} Pick one from the dropdown, or clear the custom-model field.`;
  }
  return null;
}

/** Convert any buffered provider failure into an attributed, secret-safe message. */
export function providerFailureMessage(message: string, provider: ErrorHintProvider, endpoint?: string): string {
  const safeMessage = redactUrlUserinfo(message);
  return errorHint(safeMessage, provider, endpoint) ?? `${endpointName(provider, endpoint)} failed — ${safeMessage}`;
}
