import type { PluginSettings } from "../types";
import type { Provider, ProviderId, TaskRole } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { readAnthropicEnv } from "./env";
import { resolveModelId } from "../claude/models";

/**
 * Builds providers from settings and routes a task to the right one:
 * - "chat"    → the user's primary provider (Claude by default)
 * - "utility" → the local model if enabled (summaries, tagging, ingestion),
 *               otherwise falls back to the chat provider.
 */
export class ProviderRouter {
  readonly anthropic: AnthropicProvider;
  readonly ollama: OllamaProvider;

  constructor(private settings: PluginSettings) {
    this.anthropic = new AnthropicProvider({
      mode: settings.authMode,
      apiKey: settings.apiKey,
      oauthToken: settings.oauthToken,
      baseUrl: settings.baseUrl,
      env: readAnthropicEnv(),
    });
    this.ollama = new OllamaProvider(settings.ollamaHost, settings.ollamaModel);
  }

  get(id: ProviderId): Provider {
    return id === "ollama" ? this.ollama : this.anthropic;
  }

  /** Resolve which provider + model id to use for a given task role. */
  resolve(role: TaskRole): { provider: Provider; model: string } {
    if (role === "utility" && this.settings.localUtilityEnabled && this.ollama.hasCredentials()) {
      return { provider: this.ollama, model: this.settings.ollamaModel };
    }
    // Chat honors the chosen backend: "local" forces Ollama; "claude"/"auto"
    // start on Claude (auto degrades to local on failure — handled in ChatView).
    if (role === "chat" && this.settings.chatBackend === "local" && this.ollama.hasCredentials()) {
      return { provider: this.ollama, model: this.settings.ollamaModel };
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

  /** The configured chat backend mode. */
  get chatBackend(): "claude" | "local" | "auto" {
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
