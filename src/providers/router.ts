import type { PluginSettings } from "../types";
import type { Provider, ProviderId, TaskRole } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatProvider } from "./openaiCompat";
import { readAnthropicEnv } from "./env";
import { resolveModelId } from "../claude/models";

/**
 * Settings migration for `utilityBackend`: a persisted `localUtilityEnabled`
 * (pre-split) maps to "ollama", anything else to the default ("claude").
 * Returns the backend to force, or undefined when the new key already exists.
 */
export function migrateUtilityBackend(
  persisted: Partial<{ utilityBackend: PluginSettings["utilityBackend"]; localUtilityEnabled: boolean }> | null | undefined,
): PluginSettings["utilityBackend"] | undefined {
  if (!persisted || "utilityBackend" in persisted) return undefined;
  return persisted.localUtilityEnabled === true ? "ollama" : undefined;
}

/**
 * Builds providers from settings and routes a task to the right one:
 * - "chat"    → the user's primary provider (Claude by default)
 * - "utility" → the configured utility backend (summaries, tagging, ingestion),
 *               otherwise falls back to the chat provider.
 */
export class ProviderRouter {
  readonly anthropic: AnthropicProvider;
  readonly ollama: OllamaProvider;
  readonly openaiCompat: OpenAICompatProvider;

  constructor(private settings: PluginSettings) {
    this.anthropic = new AnthropicProvider({
      mode: settings.authMode,
      apiKey: settings.apiKey,
      oauthToken: settings.oauthToken,
      baseUrl: settings.baseUrl,
      env: readAnthropicEnv(),
    });
    this.ollama = new OllamaProvider(settings.ollamaHost, settings.ollamaModel);
    this.openaiCompat = new OpenAICompatProvider(settings.openaiCompatHost, settings.openaiCompatModel, settings.openaiCompatKey);
  }

  get(id: ProviderId): Provider {
    if (id === "ollama") return this.ollama;
    if (id === "openai-compat") return this.openaiCompat;
    return this.anthropic;
  }

  /** The utility model on the Ollama backend (falls back to the chat model). */
  private ollamaUtilityModel(): string {
    return this.settings.ollamaUtilityModel.trim() || this.settings.ollamaModel;
  }

  /** Resolve which provider + model id to use for a given task role. */
  resolve(role: TaskRole): { provider: Provider; model: string } {
    if (role === "utility") {
      if (this.settings.utilityBackend === "ollama" && this.ollama.hasCredentials()) {
        return { provider: this.ollama, model: this.ollamaUtilityModel() };
      }
      if (this.settings.utilityBackend === "custom" && this.openaiCompat.hasCredentials()) {
        return { provider: this.openaiCompat, model: this.settings.openaiCompatModel };
      }
    }
    // Chat honors the chosen backend: "local" forces Ollama, "custom" the
    // OpenAI-compatible endpoint; "claude"/"auto" start on Claude (auto
    // degrades to local on failure — handled in ChatView).
    if (role === "chat") {
      if (this.settings.chatBackend === "local" && this.ollama.hasCredentials()) {
        return { provider: this.ollama, model: this.settings.ollamaModel };
      }
      if (this.settings.chatBackend === "custom" && this.openaiCompat.hasCredentials()) {
        return { provider: this.openaiCompat, model: this.settings.openaiCompatModel };
      }
    }
    return {
      provider: this.anthropic,
      model: resolveModelId(this.settings.model, this.settings.customModel),
    };
  }

  /** The provider that powers the main chat panel. */
  chatProvider(): { provider: Provider; model: string } {
    return this.resolve("chat");
  }

  /**
   * One buffered completion on a role's provider — the shared shape for the
   * summarize/tag/enrich call sites that used to hand-roll resolve+complete.
   */
  async complete(
    role: TaskRole,
    req: { system: string; user: string; maxTokens?: number; temperature?: number; responseFormat?: "json"; responseSchema?: Record<string, unknown> },
  ): Promise<{ text: string; provider: Provider }> {
    const { provider, model } = this.resolve(role);
    const text = await provider.complete({
      system: req.system,
      model,
      maxTokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0,
      messages: [{ role: "user", content: req.user }],
      ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
      ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
    });
    return { text, provider };
  }

  /** The configured chat backend mode. */
  get chatBackend(): PluginSettings["chatBackend"] {
    return this.settings.chatBackend;
  }

  /**
   * Whether a local model is actually reachable right now (cached briefly so the
   * indicator and fallback path don't hammer the Ollama server). Returns false
   * fast when no host is configured.
   */
  async localAvailable(): Promise<boolean> {
    if (!this.ollama.hasCredentials()) return false;
    const now = Date.now();
    if (this._localProbe && now - this._localProbe.at < 15000) return this._localProbe.ok;
    const ok = (await this.ollama.listModels()).length > 0;
    this._localProbe = { ok, at: now };
    return ok;
  }

  private _localProbe: { ok: boolean; at: number } | null = null;
}
