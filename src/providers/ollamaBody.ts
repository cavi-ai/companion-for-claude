// Pure request-body builder for the Ollama chat API — kept obsidian-free so
// the wire format unit-tests directly (same pattern as ollamaParse.ts).

import { type ApiMessage, type CompletionRequest, textContent } from "./types";

export function buildOllamaRequestBody(req: CompletionRequest, defaultModel: string): string {
  return JSON.stringify({
    model: req.model || defaultModel,
    stream: true,
    ...(req.responseFormat === "json" ? { format: req.responseSchema ?? "json" } : {}),
    // Thinking models (qwen3 etc.) burn the whole token budget on reasoning
    // before emitting any content; utility extractions disable it explicitly.
    ...(req.thinking?.type === "disabled" ? { think: false } : {}),
    options: { temperature: req.temperature ?? 0.7, num_predict: req.maxTokens },
    messages: [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      // Ollama has no tool-use wire format — flatten any block content to text.
      ...req.messages.map((m: ApiMessage) => ({ role: m.role, content: textContent(m.content) })),
    ],
  });
}
