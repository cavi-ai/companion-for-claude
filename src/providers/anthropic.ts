import { requestUrl } from "obsidian";
import type { StreamHandlers } from "../types";
import { parseSseChunk, extractApiError, type SseBlockState, type SseParseResult } from "../claude/sse";
import { withCacheControl } from "../claude/cache";
import { PING_MODEL } from "../claude/models";
import { capabilitiesFor } from "../claude/capabilities";
import { type CompletionRequest, type Provider, type ProviderStatus, ProviderError, isAbort } from "./types";
import { type AuthInputs, type AuthMode, type ResolvedAuth, resolveAuth, resolveAuthBaseUrl, authHeaders, messagesUrl, buildSystem } from "./auth";

export interface AnthropicConsentIdentity {
  /** Auth mode and credential shape affect which external account receives the request. */
  authMode: AuthMode;
  credentialAvailable: boolean;
  credentialScheme?: ResolvedAuth["scheme"];
  isOAuth: boolean;
  /** Exact normalized base URL snapshot that this provider would call. */
  endpoint: string;
}

/**
 * Serialize a request for the Messages API. Exported (pure) so the wire shape —
 * tools, content blocks, cache_control placement — is unit-testable.
 */
export function buildRequestBody(req: CompletionRequest, stream: boolean, auth: ResolvedAuth): string {
  // Cache breakpoints: system + tools + latest-user-message prefix (claude/cache.ts).
  const cached = withCacheControl({
    // OAuth tokens require the Claude Code identity as the first system block.
    system: buildSystem(auth, req.system),
    ...(req.tools ? { tools: req.tools } : {}),
    messages: req.messages,
  });
  const payload: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: cached.system,
    stream,
    messages: cached.messages,
  };
  if (cached.tools) payload.tools = cached.tools;
  // Model-aware fields (set by chatControls.shapeRequest); omit when absent so
  // we never send a parameter the active model would 400 on.
  // Enforce model constraints at the wire boundary too. Utility/research calls
  // do not pass through chatControls and may still request deterministic
  // sampling; current Anthropic models reject that field with HTTP 400.
  if (req.temperature !== undefined && capabilitiesFor(req.model).temperature) {
    payload.temperature = req.temperature;
  }
  if (req.thinking) {
    payload.thinking =
      req.thinkingDisplay && req.thinking.type === "adaptive"
        ? { ...req.thinking, display: req.thinkingDisplay }
        : req.thinking;
  }
  if (req.outputConfig) payload.output_config = req.outputConfig;
  return JSON.stringify(payload);
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  readonly label = "Claude (Anthropic API)";
  readonly supportsTools = true;

  constructor(private authInputs: AuthInputs) {}

  /** Resolve the active credential/headers/URL, or null if none is configured. */
  private auth(): ResolvedAuth | null {
    return resolveAuth(this.authInputs);
  }

  hasCredentials(): boolean {
    return this.auth() !== null;
  }

  /** Exact base URL snapshot used by this provider's resolved auth mode. */
  resolvedEndpoint(): string {
    return resolveAuthBaseUrl(this.authInputs);
  }

  /** Non-secret identity fields used to scope one-session fallback consent. */
  consentIdentity(): AnthropicConsentIdentity {
    const auth = this.auth();
    return {
      authMode: this.authInputs.mode,
      credentialAvailable: auth !== null,
      ...(auth ? { credentialScheme: auth.scheme } : {}),
      isOAuth: auth?.isOAuth ?? false,
      endpoint: this.resolvedEndpoint(),
    };
  }

  /** True when the active credential is a subscription OAuth token (metered usage). */
  isOAuth(): boolean {
    return this.auth()?.isOAuth ?? false;
  }

  private headers(auth: ResolvedAuth): Record<string, string> {
    return authHeaders(auth);
  }

  private body(req: CompletionRequest, stream: boolean, auth: ResolvedAuth): string {
    return buildRequestBody(req, stream, auth);
  }

  async stream(req: CompletionRequest, handlers: StreamHandlers): Promise<void> {
    const auth = this.auth();
    if (!auth) {
      handlers.onError?.(new ProviderError("No Anthropic credential set. Add an API key or OAuth token in Companion for Claude settings."));
      return;
    }
    let emitted = false;
    try {
      let buffer = "";
      let full = "";
      let stopReason: string | undefined;
      let blockState: SseBlockState = { open: {} };
      const apply = (r: SseParseResult): void => {
        if (r.error) throw new ProviderError(r.error);
        if (r.thinking) handlers.onThinking?.(r.thinking);
        if (r.text) {
          full += r.text;
          emitted = true;
          handlers.onText(r.text);
        }
        for (const block of r.toolUses) handlers.onToolUse?.(block);
        if (r.usage) handlers.onUsage?.(r.usage);
        if (r.stopReason) stopReason = r.stopReason;
      };

      const consume = (chunk: string): void => {
        buffer += chunk;
        const r = parseSseChunk(buffer, blockState);
        buffer = r.remainder;
        blockState = r.state;
        apply(r);
      };

      if (auth.isOAuth) {
        // Obsidian's native request path is the same path used by test(). In
        // particular, it preserves Authorization: Bearer on mobile/webviews,
        // where browser fetch can reject or strip subscription OAuth auth. The
        // response is buffered by requestUrl, then fed through the same SSE
        // parser so agent tool calls and stop reasons retain their semantics.
        const res = await requestUrl({
          url: messagesUrl(auth),
          method: "POST",
          headers: this.headers(auth),
          body: this.body(req, true, auth),
          throw: false,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new ProviderError(extractApiError(res.text, res.status), res.status);
        }
        if (req.signal?.aborted) return;
        consume(res.text);
      } else {
        const init: RequestInit = {
          method: "POST",
          headers: this.headers(auth),
          body: this.body(req, true, auth),
        };
        if (req.signal) init.signal = req.signal;
        const res = await window.fetch(messagesUrl(auth), init);
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new ProviderError(extractApiError(text, res.status), res.status);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          consume(decoder.decode(value, { stream: true }));
        }
      }
      // Flush a final complete event that arrived in the last chunk without a
      // trailing newline (otherwise its stop_reason/usage would be dropped).
      if (buffer.trim().length > 0) apply(parseSseChunk(buffer + "\n", blockState));
      if (stopReason === "max_tokens") handlers.onTruncated?.();
      if (stopReason) handlers.onStopReason?.(stopReason);
      handlers.onDone?.(full);
    } catch (err) {
      if (isAbort(err)) return;
      // Surface the error instead of silently degrading when a buffered fallback
      // can't safely replace what streamed: agent turns own their retry semantics
      // (tool_use blocks can't ride a buffered reply), and once any text has been
      // emitted, replaying the full reply would duplicate it in the UI.
      if (req.tools || emitted) {
        handlers.onError?.(err instanceof Error ? err : new ProviderError(String(err)));
        return;
      }
      try {
        const full = await this.complete(req);
        handlers.onText(full);
        handlers.onDone?.(full);
      } catch (err2) {
        handlers.onError?.(err2 instanceof Error ? err2 : new ProviderError(String(err2)));
      }
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const auth = this.auth();
    if (!auth) throw new ProviderError("No Anthropic credential set.");
    const res = await requestUrl({ url: messagesUrl(auth), method: "POST", headers: this.headers(auth), body: this.body(req, false, auth), throw: false });
    if (res.status < 200 || res.status >= 300) {
      throw new ProviderError(extractApiError(res.text, res.status), res.status);
    }
    const data = res.json as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  async test(): Promise<ProviderStatus> {
    const auth = this.auth();
    if (!auth) return { ok: false, detail: "No credential set — add an API key or OAuth token." };
    try {
      // Minimal 1-token ping using the cheapest path.
      const res = await requestUrl({
        url: messagesUrl(auth),
        method: "POST",
        headers: this.headers(auth),
        // Exercise the same serializer as chat. This is significant for OAuth:
        // its required Claude Code identity must be present in both the test
        // request and the real conversation request.
        body: this.body(
          {
            system: "",
            model: PING_MODEL,
            maxTokens: 1,
            messages: [{ role: "user", content: "ping" }],
          },
          false,
          auth,
        ),
        throw: false,
      });
      const how = auth.isOAuth ? "OAuth token" : "API key";
      if (res.status >= 200 && res.status < 300) return { ok: true, detail: `Connected — ${how} works${auth.isOAuth ? " (usage bills to your subscription)" : ""}.` };
      return { ok: false, detail: extractApiError(res.text, res.status) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
