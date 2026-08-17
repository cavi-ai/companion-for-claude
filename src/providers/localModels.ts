// Shared model-list assembly for the local providers (Ollama, OpenAI-compatible).
// Pure; the settings dropdowns and every chat model picker key off this.

/**
 * The models a local backend can offer: what the server reported, plus the
 * configured one. A configured model the server didn't report leads the list so
 * it stays selectable — that covers a server that is down and one whose model
 * list has changed since the id was saved.
 */
export function mergeDetectedModels(detected: string[], configured: string): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const model = raw.trim();
    if (!model || seen.has(model)) return;
    seen.add(model);
    models.push(model);
  };
  for (const model of detected) push(model);
  const current = configured.trim();
  // Only prepend when the server did not report it — a detected list keeps the
  // server's own ordering.
  if (current && !seen.has(current)) models.unshift(current);
  return models;
}
