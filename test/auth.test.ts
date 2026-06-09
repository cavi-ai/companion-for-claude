import { describe, it, expect } from "vitest";
import {
  isOAuthToken,
  isApiKey,
  normalizeBaseUrl,
  resolveAuth,
  authHeaders,
  messagesUrl,
  buildSystem,
  CLAUDE_CODE_IDENTITY,
  ANTHROPIC_DEFAULT_BASE_URL,
  OAUTH_BETA,
  API_VERSION,
  type AuthInputs,
  type ResolvedAuth,
} from "../src/providers/auth";

const base = (over: Partial<AuthInputs> = {}): AuthInputs => ({
  mode: "apiKey",
  apiKey: "",
  oauthToken: "",
  baseUrl: "",
  ...over,
});

describe("token shape detection", () => {
  it("recognizes OAuth long-term tokens", () => {
    expect(isOAuthToken("sk-ant-oat01-abc")).toBe(true);
    expect(isOAuthToken("  sk-ant-oat01-abc  ")).toBe(true);
    expect(isOAuthToken("sk-ant-api03-abc")).toBe(false);
  });
  it("recognizes API keys", () => {
    expect(isApiKey("sk-ant-api03-abc")).toBe(true);
    expect(isApiKey("sk-ant-admin01-abc")).toBe(true);
    expect(isApiKey("sk-ant-oat01-abc")).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  it("defaults to the Anthropic base URL when empty", () => {
    expect(normalizeBaseUrl("")).toBe(ANTHROPIC_DEFAULT_BASE_URL);
    expect(normalizeBaseUrl("   ")).toBe(ANTHROPIC_DEFAULT_BASE_URL);
  });
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://gw.example.com/")).toBe("https://gw.example.com");
    expect(normalizeBaseUrl("https://gw.example.com///")).toBe("https://gw.example.com");
  });
});

describe("resolveAuth — apiKey mode", () => {
  it("returns null when the key is blank", () => {
    expect(resolveAuth(base({ mode: "apiKey", apiKey: "  " }))).toBeNull();
  });
  it("resolves a key to the x-api-key scheme", () => {
    const r = resolveAuth(base({ apiKey: "sk-ant-api03-xyz" }));
    expect(r).toEqual({ credential: "sk-ant-api03-xyz", scheme: "key", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, isOAuth: false });
  });
  it("detects an OAuth token pasted into the key field and uses bearer", () => {
    const r = resolveAuth(base({ apiKey: "sk-ant-oat01-xyz" }));
    expect(r?.scheme).toBe("bearer");
    expect(r?.isOAuth).toBe(true);
  });
  it("honors a custom base URL", () => {
    const r = resolveAuth(base({ apiKey: "sk-ant-api03-xyz", baseUrl: "https://gw.example.com/" }));
    expect(r?.baseUrl).toBe("https://gw.example.com");
  });
});

describe("resolveAuth — oauthToken mode", () => {
  it("returns null when blank", () => {
    expect(resolveAuth(base({ mode: "oauthToken" }))).toBeNull();
  });
  it("always uses bearer + isOAuth, even for a non-oat string", () => {
    const r = resolveAuth(base({ mode: "oauthToken", oauthToken: "whatever" }));
    expect(r).toEqual({ credential: "whatever", scheme: "bearer", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, isOAuth: true });
  });
});

describe("resolveAuth — environment mode", () => {
  it("returns null when no env vars are set", () => {
    expect(resolveAuth(base({ mode: "environment", env: {} }))).toBeNull();
  });
  it("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN", () => {
    const r = resolveAuth(base({ mode: "environment", env: { ANTHROPIC_API_KEY: "sk-ant-api03-k", ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-t" } }));
    expect(r?.credential).toBe("sk-ant-api03-k");
    expect(r?.scheme).toBe("key");
  });
  it("falls back to ANTHROPIC_AUTH_TOKEN (bearer) when no key", () => {
    const r = resolveAuth(base({ mode: "environment", env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-t" } }));
    expect(r?.credential).toBe("sk-ant-oat01-t");
    expect(r?.scheme).toBe("bearer");
    expect(r?.isOAuth).toBe(true);
  });
  it("uses ANTHROPIC_BASE_URL when no explicit override", () => {
    const r = resolveAuth(base({ mode: "environment", env: { ANTHROPIC_API_KEY: "sk-ant-api03-k", ANTHROPIC_BASE_URL: "https://proxy.local/" } }));
    expect(r?.baseUrl).toBe("https://proxy.local");
  });
  it("lets an explicit baseUrl override the env one", () => {
    const r = resolveAuth(base({ mode: "environment", baseUrl: "https://explicit/", env: { ANTHROPIC_API_KEY: "sk-ant-api03-k", ANTHROPIC_BASE_URL: "https://proxy.local/" } }));
    expect(r?.baseUrl).toBe("https://explicit");
  });
});

describe("authHeaders", () => {
  it("uses x-api-key for the key scheme and omits oauth beta", () => {
    const h = authHeaders({ credential: "sk-ant-api03-xyz", scheme: "key", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, isOAuth: false });
    expect(h["x-api-key"]).toBe("sk-ant-api03-xyz");
    expect(h["authorization"]).toBeUndefined();
    expect(h["anthropic-beta"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe(API_VERSION);
  });
  it("uses Authorization: Bearer + oauth beta for the bearer scheme", () => {
    const h = authHeaders({ credential: "sk-ant-oat01-xyz", scheme: "bearer", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, isOAuth: true });
    expect(h["authorization"]).toBe("Bearer sk-ant-oat01-xyz");
    expect(h["anthropic-beta"]).toBe(OAUTH_BETA);
    expect(h["x-api-key"]).toBeUndefined();
  });
});

describe("messagesUrl", () => {
  it("appends the messages path to the base URL", () => {
    expect(messagesUrl({ credential: "k", scheme: "key", baseUrl: "https://gw.example.com", isOAuth: false })).toBe("https://gw.example.com/v1/messages");
  });
});

describe("buildSystem", () => {
  const keyAuth: ResolvedAuth = { credential: "k", scheme: "key", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, isOAuth: false };
  const oauthAuth: ResolvedAuth = { credential: "t", scheme: "bearer", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, isOAuth: true };

  it("passes the user prompt through unchanged for API keys", () => {
    expect(buildSystem(keyAuth, "Be concise.")).toBe("Be concise.");
  });
  it("returns undefined for an empty API-key prompt", () => {
    expect(buildSystem(keyAuth, "   ")).toBeUndefined();
  });
  it("prepends the exact Claude Code identity as the FIRST block for OAuth", () => {
    const out = buildSystem(oauthAuth, "Be concise.");
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as { type: string; text: string }[];
    expect(blocks[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect(blocks[1]).toEqual({ type: "text", text: "Be concise." });
  });
  it("uses the exact required identity string (must not drift)", () => {
    expect(CLAUDE_CODE_IDENTITY).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });
  it("still sends the identity block when the user prompt is empty (OAuth)", () => {
    const out = buildSystem(oauthAuth, "") as { type: string; text: string }[];
    expect(out).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
  });
});
