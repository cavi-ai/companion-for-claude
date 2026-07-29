// Pure request-body builder for the Ollama chat API — kept obsidian-free so
// the wire format unit-tests directly (same pattern as ollamaParse.ts).

import { type ApiMessage, type CompletionRequest, type ContentBlock, textContent } from "./types";

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

/**
 * Translate the Anthropic-shaped message list into Ollama's tool wire format:
 * assistant tool_use blocks become tool_calls on the assistant message, and
 * tool_result blocks become role "tool" messages (one per result).
 */
export function toOllamaMessages(messages: ApiMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ function: { name: b.name, arguments: b.input } }));
      const text = textContent(m.content);
      out.push({ role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // user: tool_result blocks become tool messages; everything else is text.
    const text = textContent(m.content);
    if (text) out.push({ role: "user", content: text });
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", content: b.content });
    }
  }
  return out;
}

export function buildOllamaRequestBody(req: CompletionRequest, defaultModel: string): string {
  return JSON.stringify({
    model: req.model || defaultModel,
    stream: true,
    ...(req.responseFormat === "json" ? { format: req.responseSchema ?? "json" } : {}),
    // Thinking models (qwen3 etc.) burn the whole token budget on reasoning
    // before emitting any content; utility extractions disable it explicitly.
    ...(req.thinking?.type === "disabled" ? { think: false } : {}),
    ...(req.tools && req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
        }
      : {}),
    options: { temperature: req.temperature ?? 0.7, num_predict: req.maxTokens },
    messages: [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      ...toOllamaMessages(req.messages),
    ],
  });
}
