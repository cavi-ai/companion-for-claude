// Pure (Obsidian-free) auth resolution for the Anthropic provider. Decides which
// credential + headers + base URL a request should use, given settings and the
// ambient environment. Verified empirically (2026-05-31) against the live API:
//   - API key  → `x-api-key` header.
//   - OAuth long-term token (sk-ant-oat…) → `Authorization: Bearer` + the
//     `oauth-2025-04-20` beta header, and the Claude Code identity must be
//     prepended as the first system block (buildSystem below); the user's own
//     system prompt follows it, so this stays store-safe.
//   - A token sent as `x-api-key` is rejected (401) — the header choice matters.

export type AuthMode = "apiKey" | "oauthToken" | "environment";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const API_VERSION = "2023-06-01";
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Subscription OAuth tokens require the request to present as Claude Code: the
 * FIRST system block must be exactly this string, or the API returns 429
 * `rate_limit_error` (a misleading "out of usage" — credits are unaffected).
 * Verified empirically 2026-05-31: exact match required, must be block 0, blocks
 * after it are fine, any block before it 429s. API-key requests don't need this.
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** A single system block in the Anthropic `system` array form. */
export interface SystemBlock {
  type: "text";
  text: string;
}

/**
 * Build the `system` field for a request given the resolved auth and the user's
 * own system prompt. For OAuth tokens, prepend the required Claude Code identity
 * as the first block (the user's prompt follows it). For API keys, pass the
 * user's prompt through unchanged (string form, or undefined when empty).
 */
export function buildSystem(auth: ResolvedAuth, userSystem: string): string | SystemBlock[] | undefined {
  const trimmed = (userSystem ?? "").trim();
  if (auth.isOAuth) {
    const blocks: SystemBlock[] = [{ type: "text", text: CLAUDE_CODE_IDENTITY }];
    if (trimmed) blocks.push({ type: "text", text: userSystem });
    return blocks;
  }
  return trimmed ? userSystem : undefined;
}

/** A long-term OAuth token from `claude setup-token` (CI) or the CLI keychain. */
export function isOAuthToken(token: string): boolean {
  return /^sk-ant-oat/.test(token.trim());
}

/** A standard Anthropic API key. */
export function isApiKey(token: string): boolean {
  return /^sk-ant-(api|admin)/.test(token.trim());
}

export interface AuthInputs {
  mode: AuthMode;
  /** User-entered Anthropic API key (apiKey mode). */
  apiKey: string;
  /** User-pasted long-term OAuth token (oauthToken mode). */
  oauthToken: string;
  /** Optional override base URL (e.g. a gateway). Empty = Anthropic default. */
  baseUrl: string;
  /** Values discovered from the process environment (environment mode). */
  env?: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_AUTH_TOKEN?: string;
    ANTHROPIC_BASE_URL?: string;
  };
}

export interface ResolvedAuth {
  /** The credential string actually used (never logged). */
  credential: string;
  /** "key" → x-api-key; "bearer" → Authorization: Bearer. */
  scheme: "key" | "bearer";
  /** Fully-resolved base URL with no trailing slash. */
  baseUrl: string;
  /** Whether this credential is a subscription OAuth token. */
  isOAuth: boolean;
}

/** Strip a trailing slash so callers can append `/v1/messages` safely. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return ANTHROPIC_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Resolve which credential, header scheme, and base URL to use. Returns null
 * when the selected mode has no usable credential (caller surfaces a friendly
 * "add a key / token" message instead of sending a doomed request).
 */
export function resolveAuth(inputs: AuthInputs): ResolvedAuth | null {
  const env = inputs.env ?? {};

  if (inputs.mode === "environment") {
    // Mirror the SDK precedence: explicit key, then auth token.
    const envKey = (env.ANTHROPIC_API_KEY ?? "").trim();
    const envToken = (env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
    const baseUrl = normalizeBaseUrl(inputs.baseUrl || env.ANTHROPIC_BASE_URL || "");
    if (envKey) {
      return { credential: envKey, scheme: schemeFor(envKey), baseUrl, isOAuth: isOAuthToken(envKey) };
    }
    if (envToken) {
      // ANTHROPIC_AUTH_TOKEN is a Bearer credential by SDK convention (gateway
      // tokens, subscription OAuth); it must never go on x-api-key (→ 401). Only
      // genuine sk-ant-oat tokens are treated as OAuth (Claude Code identity block).
      return { credential: envToken, scheme: "bearer", baseUrl, isOAuth: isOAuthToken(envToken) };
    }
    return null;
  }

  const baseUrl = normalizeBaseUrl(inputs.baseUrl);

  if (inputs.mode === "oauthToken") {
    const tok = inputs.oauthToken.trim();
    if (!tok) return null;
    return { credential: tok, scheme: "bearer", baseUrl, isOAuth: true };
  }

  // apiKey (default)
  const key = inputs.apiKey.trim();
  if (!key) return null;
  return { credential: key, scheme: schemeFor(key), baseUrl, isOAuth: isOAuthToken(key) };
}

/** Pick the header scheme for a bare credential by shape. */
function schemeFor(credential: string): "key" | "bearer" {
  return isOAuthToken(credential) ? "bearer" : "key";
}

/**
 * Build the request headers for a resolved credential. OAuth tokens go on
 * `Authorization: Bearer` with the oauth beta header; API keys go on `x-api-key`.
 */
export function authHeaders(auth: ResolvedAuth): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (auth.scheme === "bearer") {
    headers["authorization"] = `Bearer ${auth.credential}`;
    // The oauth beta header belongs only to genuine subscription OAuth tokens;
    // a plain Bearer (e.g. a gateway auth token) must not carry it.
    if (auth.isOAuth) headers["anthropic-beta"] = OAUTH_BETA;
  } else {
    headers["x-api-key"] = auth.credential;
  }
  return headers;
}

/** The Messages endpoint for a resolved base URL. */
export function messagesUrl(auth: ResolvedAuth): string {
  return `${auth.baseUrl}/v1/messages`;
}
