// Map a raw provider error message to an actionable hint. Pure + testable.

export function errorHint(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("401") || m.includes("invalid api key") || m.includes("authentication")) {
    return "Open Settings → Companion for Claude and check your Anthropic API key. Keys start with “sk-ant-”.";
  }
  if (m.includes("not_found") || m.includes("404") || m.includes("model")) {
    return "That model id may be wrong. Pick one from the dropdown, or clear the custom-model field.";
  }
  if (m.includes("429") || m.includes("rate")) {
    return "Rate limited (HTTP 429). Wait a moment and retry. On a subscription OAuth token this can also mean a per-minute/usage cap on your plan — it does not necessarily mean your API credits are exhausted.";
  }
  if (m.includes("ollama") || m.includes("11434") || m.includes("econnrefused") || m.includes("fetch failed")) {
    return "Can’t reach the local model. Run `ollama serve`, then verify the host in settings (default http://localhost:11434).";
  }
  if (m.includes("credit") || m.includes("billing") || m.includes("quota")) {
    return "This looks like a billing/credit issue. Add credits in the Anthropic console.";
  }
  return null;
}
