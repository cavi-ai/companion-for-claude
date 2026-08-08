import type { PluginSettings } from "../types";
import type { Provider, ProviderId, TaskRole, CompletionRequest } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatProvider } from "./openaiCompat";
import { readAnthropicEnv, type AnthropicEnv } from "./env";
import { resolveModelId } from "../claude/models";
import {
  resolveUtilityForRuntime as applyUtilityRuntimePolicy,
  sanitizeEndpointForDisplay,
  type UtilityFallbackApproval,
  type UtilityRuntimeResolution,
} from "./endpointPolicy";
import { providerFailureMessage } from "./errorHints";

export interface ProviderSelection {
  provider: Provider;
  model: string;
  /** Sanitized endpoint snapshot for accurate, secret-safe error attribution. */
  endpoint?: string;
}

export type UtilitySelectionResolver = () => Promise<ProviderSelection>;

export type RuntimeUtilitySelection =
  | (Extract<UtilityRuntimeResolution, { state: "configured-provider" | "approved-Claude-fallback" }> & ProviderSelection)
  | Exclude<UtilityRuntimeResolution, { state: "configured-provider" | "approved-Claude-fallback" }>;

export interface UtilityFallbackConsentContext {
  /** Opaque in-memory identity for this exact provider/router revision. */
  identity: object;
  /** Non-secret identity for the configured source and displayed destination. */
  destinationFingerprint: string;
  configuredBackend: "ollama" | "custom";
  configuredEndpoint: string;
  fallbackProvider: "anthropic";
  fallbackEndpoint: string;
}

type BufferedCompletionInput = {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "json";
  responseSchema?: Record<string, unknown>;
  thinking?: CompletionRequest["thinking"];
};

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
 * - "utility" → the configured utility backend (summaries, tagging, ingestion).
 * Runtime-specific fallback is explicit through resolveUtilityForRuntime().
 */
export class ProviderRouter {
  readonly anthropic: AnthropicProvider;
  readonly ollama: OllamaProvider;
  readonly openaiCompat: OpenAICompatProvider;
  private readonly anthropicEnv: AnthropicEnv;
  private readonly utilityConsentIdentity = Object.freeze({});

  constructor(
    private settings: PluginSettings,
    private utilitySelectionResolver?: UtilitySelectionResolver,
  ) {
    this.anthropicEnv = readAnthropicEnv();
    this.anthropic = new AnthropicProvider({
      mode: settings.authMode,
      apiKey: settings.apiKey,
      oauthToken: settings.oauthToken,
      baseUrl: settings.baseUrl,
      env: this.anthropicEnv,
    });
    this.ollama = new OllamaProvider(settings.ollamaHost, settings.ollamaModel);
    this.openaiCompat = new OpenAICompatProvider(settings.openaiCompatHost, settings.openaiCompatModel, settings.openaiCompatKey);
  }

  /** Whether an environment-auth provider still represents the live process environment. */
  hasCurrentAnthropicEnvironment(): boolean {
    if (this.settings.authMode !== "environment") return true;
    const current = readAnthropicEnv();
    return (
      current.ANTHROPIC_API_KEY === this.anthropicEnv.ANTHROPIC_API_KEY &&
      current.ANTHROPIC_AUTH_TOKEN === this.anthropicEnv.ANTHROPIC_AUTH_TOKEN &&
      current.ANTHROPIC_BASE_URL === this.anthropicEnv.ANTHROPIC_BASE_URL
    );
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
      if (this.settings.utilityBackend === "ollama") {
        return { provider: this.ollama, model: this.ollamaUtilityModel() };
      }
      if (this.settings.utilityBackend === "custom") {
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

  /** Resolve the configured utility backend against mobile endpoint reachability and session consent. */
  resolveUtilityForRuntime(input: {
    isMobile: boolean;
    fallbackApproval?: UtilityFallbackApproval;
  }): RuntimeUtilitySelection {
    const backend = this.settings.utilityBackend;
    const claudeEndpoint = this.anthropic.resolvedEndpoint();
    const endpoint =
      backend === "ollama"
        ? this.settings.ollamaHost
        : backend === "custom"
          ? this.settings.openaiCompatHost
          : claudeEndpoint;
    const resolution = applyUtilityRuntimePolicy({
      backend,
      ...(endpoint !== undefined ? { endpoint } : {}),
      isMobile: input.isMobile,
      claudeAvailable: this.anthropic.hasCredentials(),
      claudeEndpoint,
      ...(input.fallbackApproval ? { fallbackApproval: input.fallbackApproval } : {}),
    });
    if (resolution.state === "approved-Claude-fallback") {
      return {
        ...resolution,
        provider: this.anthropic,
        model: resolveModelId(this.settings.model, this.settings.customModel),
        endpoint: sanitizeEndpointForDisplay(claudeEndpoint),
      };
    }
    if (resolution.state === "configured-provider") {
      const selection = this.resolve("utility");
      return {
        ...resolution,
        ...selection,
        endpoint: sanitizeEndpointForDisplay(
          selection.provider.id === "ollama"
            ? this.settings.ollamaHost
            : selection.provider.id === "openai-compat"
              ? this.settings.openaiCompatHost
              : claudeEndpoint,
        ),
      };
    }
    return resolution;
  }

  /**
   * Consent identity for a mobile-local utility endpoint. It includes both the
   * configured source endpoint and the actual resolved Anthropic destination,
   * so a cached decision cannot silently follow a settings/environment change.
   */
  utilityFallbackConsentContext(isMobile: boolean): UtilityFallbackConsentContext | null {
    const resolution = this.resolveUtilityForRuntime({ isMobile });
    if (resolution.state !== "unavailable-loopback") return null;
    const fallbackEndpoint = sanitizeEndpointForDisplay(this.anthropic.resolvedEndpoint());
    return {
      identity: this.utilityConsentIdentity,
      destinationFingerprint: JSON.stringify({
        configuredBackend: resolution.backend,
        configuredEndpoint: resolution.endpoint,
        fallbackProvider: "anthropic",
        fallbackEndpoint,
        fallbackAuthMode: this.settings.authMode,
      }),
      configuredBackend: resolution.backend,
      configuredEndpoint: resolution.endpoint,
      fallbackProvider: "anthropic",
      fallbackEndpoint,
    };
  }

  /** Resolve utility network access through the plugin-owned runtime/privacy gate. */
  async utilitySelection(): Promise<ProviderSelection> {
    if (!this.utilitySelectionResolver) {
      throw new Error("Utility completion requires a runtime resolver; use completeResolved with an explicitly approved selection.");
    }
    return this.utilitySelectionResolver();
  }

  /**
   * Whether the current chat backend can run tool-driven agent turns. Claude
   * always can; local providers must report "tools" for the selected model
   * (unqueryable → not capable, so the UI never offers a broken agent).
   */
  async chatToolCapable(): Promise<boolean> {
    const { provider, model } = this.chatProvider();
    if (provider.id === "anthropic") return true;
    if (provider.supportsTools !== true || !provider.capabilities) return provider.supportsTools === true;
    try {
      return (await provider.capabilities(model)).includes("tools");
    } catch {
      return false;
    }
  }

  /**
   * Whether the current chat backend reasons before answering: Claude with
   * thinking toggled on, or a local model whose metadata reports "thinking".
   */
  async chatReasoningActive(thinkingToggled: boolean): Promise<boolean> {
    const { provider, model } = this.chatProvider();
    if (provider.id === "anthropic") return thinkingToggled;
    if (!provider.capabilities) return false;
    try {
      return (await provider.capabilities(model)).includes("thinking");
    } catch {
      return false;
    }
  }

  /**
   * One buffered completion on a role's provider — the shared shape for the
   * summarize/tag/enrich call sites that used to hand-roll resolve+complete.
   */
  async complete(
    role: TaskRole,
    req: BufferedCompletionInput,
  ): Promise<{ text: string; provider: Provider }> {
    const selection = role === "utility" ? await this.utilitySelection() : this.resolve(role);
    return this.completeResolved(selection, req);
  }

  /** Complete with a selection already resolved by the caller's runtime/privacy policy. */
  async completeResolved(
    selection: ProviderSelection,
    req: BufferedCompletionInput,
  ): Promise<{ text: string; provider: Provider }> {
    const { provider, model } = selection;
    try {
      const text = await provider.complete({
        system: req.system,
        model,
        maxTokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
        messages: [{ role: "user", content: req.user }],
        ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
        ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
        ...(req.thinking ? { thinking: req.thinking } : {}),
      });
      return { text, provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(providerFailureMessage(message, provider.id, selection.endpoint), { cause: error });
    }
  }

  /** The configured chat backend mode. */
  get chatBackend(): PluginSettings["chatBackend"] {
    return this.settings.chatBackend;
  }

  /**
   * Whether a local model is actually reachable right now (cached briefly so the
   * indicator and fallback path don't hammer the servers). Returns false fast
   * when no local backend is configured.
   */
  async localAvailable(): Promise<boolean> {
    return (await this.localFallback()) !== null;
  }

  /**
   * The local backend a failed Claude turn can fall back to: Ollama first
   * (the classic path), then the custom OpenAI-compatible endpoint when it's
   * configured. Probes are cached 15s so the fallback decision stays cheap.
   */
  async localFallback(): Promise<{ provider: Provider; model: string } | null> {
    const now = Date.now();
    if (this._localProbe && now - this._localProbe.at < 15000) return this._localProbe.fallback;
    let fallback: { provider: Provider; model: string } | null = null;
    if (this.ollama.hasCredentials() && (await this.ollama.listModels()).length > 0) {
      fallback = { provider: this.ollama, model: this.settings.ollamaModel };
    } else if (
      this.openaiCompat.hasCredentials() &&
      this.settings.openaiCompatModel.trim() &&
      (await this.openaiCompat.listModels()).length > 0
    ) {
      fallback = { provider: this.openaiCompat, model: this.settings.openaiCompatModel };
    }
    this._localProbe = { fallback, at: now };
    return fallback;
  }

  private _localProbe: { fallback: { provider: Provider; model: string } | null; at: number } | null = null;
}
