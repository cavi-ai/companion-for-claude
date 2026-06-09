import { describe, it, expect } from "vitest";
import { isOfflineOrUsageError, shouldFallbackToLocal, primaryBackend, fallbackReason } from "../src/providers/fallback";

describe("isOfflineOrUsageError", () => {
  it("treats rate-limit / usage / server errors as fallback-worthy (by status)", () => {
    for (const status of [429, 401, 403, 500, 503, 529]) {
      expect(isOfflineOrUsageError({ status })).toBe(true);
    }
  });
  it("treats network/offline messages as fallback-worthy", () => {
    for (const m of ["fetch failed", "Failed to fetch", "network error", "ECONNREFUSED", "getaddrinfo ENOTFOUND", "request timeout", "offline"]) {
      expect(isOfflineOrUsageError({ message: m })).toBe(true);
    }
  });
  it("does NOT fall back on a 400 bad-request (prompt/params problem)", () => {
    expect(isOfflineOrUsageError({ status: 400, message: "invalid_request: bad param" })).toBe(false);
  });
  it("is false for null/undefined", () => {
    expect(isOfflineOrUsageError(null)).toBe(false);
    expect(isOfflineOrUsageError(undefined)).toBe(false);
  });
});

describe("shouldFallbackToLocal", () => {
  const offline = { message: "fetch failed" };
  it("never falls back when the turn already ran locally", () => {
    expect(shouldFallbackToLocal({ backend: "local", localAvailable: true, error: offline })).toBe(false);
  });
  it("never falls back when no local model is available", () => {
    expect(shouldFallbackToLocal({ backend: "auto", localAvailable: false, error: offline })).toBe(false);
  });
  it("auto falls back on an offline/usage error when local is available", () => {
    expect(shouldFallbackToLocal({ backend: "auto", localAvailable: true, error: offline })).toBe(true);
    expect(shouldFallbackToLocal({ backend: "auto", localAvailable: true, error: { status: 429 } })).toBe(true);
  });
  it("claude-only still degrades gracefully on offline/usage (keeps you working)", () => {
    expect(shouldFallbackToLocal({ backend: "claude", localAvailable: true, error: offline })).toBe(true);
  });
  it("does not fall back on a 400 even with local available", () => {
    expect(shouldFallbackToLocal({ backend: "auto", localAvailable: true, error: { status: 400 } })).toBe(false);
  });
});

describe("primaryBackend", () => {
  it("local mode starts local", () => {
    expect(primaryBackend("local")).toBe("local");
  });
  it("claude and auto start on claude", () => {
    expect(primaryBackend("claude")).toBe("claude");
    expect(primaryBackend("auto")).toBe("claude");
  });
});

describe("fallbackReason", () => {
  it("summarizes usage vs network vs auth vs server", () => {
    expect(fallbackReason({ status: 429 })).toMatch(/usage|rate/i);
    expect(fallbackReason({ message: "fetch failed" })).toMatch(/connection/i);
    expect(fallbackReason({ status: 401 })).toMatch(/credential/i);
    expect(fallbackReason({ status: 500 })).toMatch(/service/i);
  });
});
