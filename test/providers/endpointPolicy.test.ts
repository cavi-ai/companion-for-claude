import { describe, expect, it } from "vitest";
import { classifyEndpoint, resolveUtilityForRuntime, sanitizeEndpointForDisplay } from "../../src/providers/endpointPolicy";

describe("classifyEndpoint", () => {
  it.each([
    ["http://localhost:11434", "loopback"],
    ["http://worker.localhost:11434", "loopback"],
    ["http://localhost.localdomain:11434", "loopback"],
    ["http://ip6-localhost:11434", "loopback"],
    ["http://ip6-loopback:11434", "loopback"],
    ["http://127.0.0.1:11434", "loopback"],
    ["http://[::1]:11434", "loopback"],
    ["http://0.0.0.0:11434", "wildcard-local"],
    ["http://[::]:11434", "wildcard-local"],
    ["http://[::ffff:127.0.0.1]:11434", "loopback"],
    ["http://[::ffff:7f00:1]:11434", "loopback"],
    ["http://[::127.0.0.1]:11434", "loopback"],
    ["http://[::7f00:1]:11434", "loopback"],
    ["http://[::ffff:0.0.0.0]:11434", "wildcard-local"],
    ["http://[::ffff:0:0]:11434", "wildcard-local"],
    ["http://192.168.1.24:11434", "lan"],
    ["http://ollama.lan:11434", "remote"],
    ["http://studio.local:1234", "remote"],
    ["https://models.example.com", "remote"],
    ["https://models.example.com/v1", "remote"],
    ["ftp://models.example.com/v1", "invalid"],
    ["http://user:password@models.example.com/v1", "invalid"],
    ["http://@models.example.com/v1", "invalid"],
    ["https://models.example.com/v1?token=secret", "invalid"],
    ["https://models.example.com/v1?", "invalid"],
    ["https://models.example.com/v1#private", "invalid"],
    ["https://models.example.com/v1#", "invalid"],
    ["https://bad_host.example.com/v1", "invalid"],
    ["https://-models.example.com/v1", "invalid"],
    ["https://models..example.com/v1", "invalid"],
    ["http://exa mple.com", "invalid"],
    ["not a url", "invalid"],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(classifyEndpoint(url)).toBe(expected);
  });
});

describe("sanitizeEndpointForDisplay", () => {
  it("removes userinfo, query, and fragment from a parseable legacy endpoint", () => {
    expect(sanitizeEndpointForDisplay("http://alice:supersecret@models.example.com:1234/v1?token=private#fragment"))
      .toBe("http://models.example.com:1234/v1");
  });

  it("does not expose userinfo from a malformed legacy endpoint", () => {
    const display = sanitizeEndpointForDisplay("http://alice:supersecret@");
    expect(display).not.toContain("alice");
    expect(display).not.toContain("supersecret");
  });

  it.each([
    "ssh://alice:supersecret@models.example.com/v1",
    "ftp://alice:supersecret@models.example.com/v1",
    "alice:supersecret@models.example.com",
  ])("uses a generic placeholder for a non-HTTP userinfo-like endpoint %s", (endpoint) => {
    const display = sanitizeEndpointForDisplay(endpoint);
    expect(display).toBe("(invalid endpoint)");
    expect(display).not.toMatch(/alice|supersecret|ssh|ftp/i);
  });
});

describe("resolveUtilityForRuntime", () => {
  it("keeps the configured loopback provider on desktop", () => {
    expect(resolveUtilityForRuntime({
      backend: "ollama",
      endpoint: "http://localhost:11434",
      isMobile: false,
      claudeAvailable: true,
    })).toEqual({ state: "configured-provider", backend: "ollama" });
  });

  it.each([
    ["http://192.168.1.24:11434", "lan"],
    ["https://models.example.com", "remote"],
  ] as const)("keeps a mobile %s endpoint on the configured provider", (endpoint, _classification) => {
    expect(resolveUtilityForRuntime({
      backend: "custom",
      endpoint,
      isMobile: true,
      claudeAvailable: true,
    })).toEqual({ state: "configured-provider", backend: "custom" });
  });

  it("requires approval before mobile can replace a loopback provider with Claude", () => {
    expect(resolveUtilityForRuntime({
      backend: "ollama",
      endpoint: "http://127.0.0.1:11434",
      isMobile: true,
      claudeAvailable: true,
    })).toEqual({
      state: "unavailable-loopback",
      backend: "ollama",
      endpoint: "http://127.0.0.1:11434",
    });
  });

  it("uses Claude only after mobile fallback approval", () => {
    expect(resolveUtilityForRuntime({
      backend: "custom",
      endpoint: "http://localhost:1234",
      isMobile: true,
      claudeAvailable: true,
      fallbackApproval: "allow",
    })).toEqual({
      state: "approved-Claude-fallback",
      backend: "claude",
      configuredBackend: "custom",
      endpoint: "http://localhost:1234",
    });
  });

  it("does not fall back after mobile fallback denial", () => {
    expect(resolveUtilityForRuntime({
      backend: "ollama",
      endpoint: "http://localhost:11434",
      isMobile: true,
      claudeAvailable: true,
      fallbackApproval: "deny",
    })).toEqual({
      state: "unavailable-without-Claude",
      backend: "ollama",
      endpoint: "http://localhost:11434",
      reason: "fallback-denied",
    });
  });

  it("does not offer fallback when Claude has no credential", () => {
    expect(resolveUtilityForRuntime({
      backend: "custom",
      endpoint: "http://localhost:1234",
      isMobile: true,
      claudeAvailable: false,
    })).toEqual({
      state: "unavailable-without-Claude",
      backend: "custom",
      endpoint: "http://localhost:1234",
      reason: "claude-unavailable",
    });
  });

  it("rejects an invalid configured endpoint on mobile without sending to Claude", () => {
    expect(resolveUtilityForRuntime({
      backend: "custom",
      endpoint: "not a url",
      isMobile: true,
      claudeAvailable: true,
    })).toEqual({
      state: "unavailable-without-Claude",
      backend: "custom",
      endpoint: "(invalid endpoint)",
      reason: "invalid-endpoint",
    });
  });

  it("returns no callable selection when configured Claude has no credentials", () => {
    expect(resolveUtilityForRuntime({
      backend: "claude",
      endpoint: "https://gateway.example.com/v1",
      isMobile: true,
      claudeAvailable: false,
    })).toEqual({
      state: "unavailable-without-Claude",
      backend: "claude",
      endpoint: "https://gateway.example.com/v1",
      reason: "claude-unavailable",
    });
  });

  it("redacts userinfo when returning an invalid endpoint", () => {
    const result = resolveUtilityForRuntime({
      backend: "custom",
      endpoint: "http://alice:supersecret@models.example.com/v1",
      isMobile: true,
      claudeAvailable: true,
    });
    expect(result).toEqual({
      state: "unavailable-without-Claude",
      backend: "custom",
      endpoint: "http://models.example.com/v1",
      reason: "invalid-endpoint",
    });
    expect(JSON.stringify(result)).not.toContain("supersecret");
  });

  it("does not echo a non-HTTP scheme or its userinfo from an invalid resolution", () => {
    const result = resolveUtilityForRuntime({
      backend: "custom",
      endpoint: "ssh://alice:supersecret@models.example.com/v1",
      isMobile: true,
      claudeAvailable: true,
    });
    expect(result).toEqual({
      state: "unavailable-without-Claude",
      backend: "custom",
      endpoint: "(invalid endpoint)",
      reason: "invalid-endpoint",
    });
    expect(JSON.stringify(result)).not.toMatch(/alice|supersecret|ssh/i);
  });
});
