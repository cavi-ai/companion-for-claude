import { requestUrl } from "obsidian";
import type { StreamHandlers } from "../types";
import { type CompletionRequest, type Provider, type ProviderStatus, ProviderError, isAbort } from "./types";
import { parseOllamaLine, type OllamaToolCall } from "./ollamaParse";
import { buildOllamaRequestBody } from "./ollamaBody";

/**
 * Local model provider speaking the Ollama HTTP API (http://localhost:11434).
 * Used for cheap/bulk "utility" work — summaries, tagging, ingestion — so
 * Anthropic tokens are reserved for high-level reasoning.
 */
export class OllamaProvider implements Provider {
  readonly id = "ollama" as const;
  readonly label = "Local (Ollama)";
  // Ollama's /api/chat supports function tools natively on tool-capable models
  // (llama3.1+, qwen3, …); on older models the tools key is ignored and the
  // turn degrades to plain chat.
  readonly supportsTools = true;

  constructor(
    private host: string,
    private defaultModel: string,
  ) {}

  private base(): string {
    return this.host.replace(/\/+$/, "");
  }

  hasCredentials(): boolean {
    return this.base().length > 0;
  }

  private body(req: CompletionRequest): string {
    return buildOllamaRequestBody(req, this.defaultModel);
  }

  async stream(req: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    try {
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.body(req),
      };
      if (req.signal) init.signal = req.signal;
      const res = await window.fetch(`${this.base()}/api/chat`, init);
      if (!res.ok || !res.body) {
        throw new ProviderError(`Ollama error ${res.status}. Is \`ollama serve\` running at ${this.base()}?`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      const toolCalls: OllamaToolCall[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const { text, error, toolCalls: chunkCalls } = parseOllamaLine(line);
          if (error) throw new ProviderError(error);
          if (text) {
            full += text;
            handlers.onText(text);
          }
          if (chunkCalls) toolCalls.push(...chunkCalls);
        }
      }
      // Tool calls arrive complete in the final chunks; emit after the stream
      // ends (the agent loop collects them before its own stop handling).
      toolCalls.forEach((call, i) => {
        handlers.onToolUse?.({ type: "tool_use", id: `ollama-tc-${i}`, name: call.name, input: call.input });
      });
      if (toolCalls.length > 0) handlers.onStopReason?.("tool_use");
      handlers.onDone?.(full);
    } catch (err) {
      if (isAbort(err)) return;
      handlers.onError?.(err instanceof Error ? err : new ProviderError(String(err)));
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const res = await requestUrl({
      url: `${this.base()}/api/chat`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(this.body(req)), stream: false }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ProviderError(`Ollama error ${res.status} at ${this.base()}.`, res.status);
    }
    const data = res.json as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  async test(): Promise<ProviderStatus> {
    try {
      const res = await requestUrl({ url: `${this.base()}/api/tags`, method: "GET", throw: false });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, detail: `Ollama not reachable at ${this.base()} (status ${res.status}).` };
      }
      const data = res.json as { models?: Array<{ name: string }> };
      const names = (data.models ?? []).map((m) => m.name);
      if (names.length === 0) return { ok: true, detail: `Reachable, but no models pulled. Try: ollama pull ${this.defaultModel}` };
      return { ok: true, detail: `Connected — ${names.length} model(s): ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}` };
    } catch (err) {
      return { ok: false, detail: `Ollama not reachable at ${this.base()}. Is it running? (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  /** List locally available models (for the settings dropdown). */
  async listModels(): Promise<string[]> {
    try {
      const res = await requestUrl({ url: `${this.base()}/api/tags`, method: "GET", throw: false });
      if (res.status < 200 || res.status >= 300) return [];
      const data = res.json as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Model capability flags from /api/show ("tools", "thinking", "vision", …),
   * cached per model. Empty array when the server or model can't be queried —
   * callers treat that as "unknown", not as proof of incapability.
   */
  private capsCache = new Map<string, string[]>();

  async capabilities(model: string): Promise<readonly string[]> {
    const key = model.trim() || this.defaultModel;
    const cached = this.capsCache.get(key);
    if (cached) return cached;
    let caps: string[] = [];
    try {
      const res = await requestUrl({ url: `${this.base()}/api/show`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: key }), throw: false });
      if (res.status >= 200 && res.status < 300) {
        const data = res.json as { capabilities?: unknown };
        if (Array.isArray(data.capabilities)) caps = data.capabilities.filter((c): c is string => typeof c === "string");
      }
    } catch {
      /* unreachable → empty */
    }
    this.capsCache.set(key, caps);
    return caps;
  }

  /**
   * Embed one or more texts with the given embedding model (e.g. nomic-embed-text).
   * Uses Ollama's /api/embed; returns one vector per input in order. Throws
   * ProviderError on failure so the indexer can surface a clear message.
   */
  async embed(model: string, input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    const res = await requestUrl({
      url: `${this.base()}/api/embed`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ProviderError(
        `Ollama embeddings error ${res.status} at ${this.base()} (model "${model}"). ` +
          `Pull it with: ollama pull ${model}`,
        res.status,
      );
    }
    const data = res.json as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== input.length) {
      throw new ProviderError(`Ollama returned no embeddings for model "${model}".`);
    }
    return data.embeddings;
  }
}
