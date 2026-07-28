import { requestUrl } from "obsidian";
import type { StreamHandlers } from "../types";
import { type ApiMessage, type CompletionRequest, type Provider, type ProviderStatus, ProviderError, isAbort, textContent } from "./types";

/**
 * Provider for any OpenAI-compatible local endpoint — LM Studio, mlx-lm,
 * vLLM, Jan, Ollama's /v1 mode. This is the path to Apple-silicon-optimized
 * models (e.g. via `mlx_lm.server`) without any native code: the webview only
 * ever speaks HTTP to a loopback server.
 */
export class OpenAICompatProvider implements Provider {
  readonly id = "openai-compat" as const;
  readonly label = "Local (OpenAI-compatible)";

  constructor(
    private host: string,
    private defaultModel: string,
    private apiKey: string,
  ) {}

  /** The /v1 API root — accepts hosts given with or without the /v1 suffix. */
  private base(): string {
    const b = this.host.replace(/\/+$/, "");
    return b.endsWith("/v1") ? b : `${b}/v1`;
  }

  hasCredentials(): boolean {
    return this.host.trim().length > 0;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey.trim()) h.authorization = `Bearer ${this.apiKey.trim()}`;
    return h;
  }

  private body(req: CompletionRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model || this.defaultModel,
      stream,
      ...(req.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        // No tool-use translation — flatten any block content to text.
        ...req.messages.map((m: ApiMessage) => ({ role: m.role, content: textContent(m.content) })),
      ],
    });
  }

  async stream(req: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    try {
      const init: RequestInit = {
        method: "POST",
        headers: this.headers(),
        body: this.body(req, true),
      };
      if (req.signal) init.signal = req.signal;
      const res = await window.fetch(`${this.base()}/chat/completions`, init);
      if (!res.ok || !res.body) {
        throw new ProviderError(`Endpoint error ${res.status} at ${this.base()}. Is the server running?`, res.status);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let delta: string | undefined;
          try {
            const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            delta = parsed.choices?.[0]?.delta?.content;
          } catch {
            continue; // keepalive / partial frame — skip
          }
          if (delta) {
            full += delta;
            handlers.onText(delta);
          }
        }
      }
      handlers.onDone?.(full);
    } catch (err) {
      if (isAbort(err)) return;
      handlers.onError?.(err instanceof Error ? err : new ProviderError(String(err)));
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const res = await requestUrl({
      url: `${this.base()}/chat/completions`,
      method: "POST",
      headers: this.headers(),
      body: this.body(req, false),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ProviderError(`Endpoint error ${res.status} at ${this.base()}.`, res.status);
    }
    const data = res.json as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async test(): Promise<ProviderStatus> {
    const models = await this.listModels();
    if (models.length > 0) {
      return { ok: true, detail: `Connected — ${models.length} model(s): ${models.slice(0, 6).join(", ")}${models.length > 6 ? "…" : ""}` };
    }
    try {
      const res = await requestUrl({ url: `${this.base()}/models`, method: "GET", headers: this.headers(), throw: false });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, detail: `Endpoint at ${this.base()} answered ${res.status}. Check the host and API key.` };
      }
      return { ok: true, detail: "Reachable, but the server reports no models." };
    } catch (err) {
      return { ok: false, detail: `Endpoint not reachable at ${this.base()}. (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  /** List models the server exposes (for the settings dropdown). */
  async listModels(): Promise<string[]> {
    try {
      const res = await requestUrl({ url: `${this.base()}/models`, method: "GET", headers: this.headers(), throw: false });
      if (res.status < 200 || res.status >= 300) return [];
      const data = res.json as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Embed via POST /v1/embeddings; one vector per input in order. */
  async embed(model: string, input: string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    const res = await requestUrl({
      url: `${this.base()}/embeddings`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new ProviderError(`Embeddings error ${res.status} at ${this.base()} (model "${model}").`, res.status);
    }
    const data = res.json as { data?: Array<{ embedding?: number[] }> };
    const vectors = (data.data ?? []).map((d) => d.embedding ?? []);
    if (vectors.length !== input.length || vectors.some((v) => v.length === 0)) {
      throw new ProviderError(`Endpoint returned no embeddings for model "${model}".`);
    }
    return vectors;
  }
}
