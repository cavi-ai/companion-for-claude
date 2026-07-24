import { describe, it, expect } from "vitest";
import { needsCredentialSetup } from "../src/providers/setupState";

describe("needsCredentialSetup", () => {
  it("gates the claude backend when no Anthropic credential exists", () => {
    expect(needsCredentialSetup({ backend: "claude", hasAnthropicCredential: false })).toBe(true);
    expect(needsCredentialSetup({ backend: "claude", hasAnthropicCredential: true })).toBe(false);
  });
  it("gates auto the same way — auto starts on Anthropic", () => {
    expect(needsCredentialSetup({ backend: "auto", hasAnthropicCredential: false })).toBe(true);
    expect(needsCredentialSetup({ backend: "auto", hasAnthropicCredential: true })).toBe(false);
  });
  it("never gates the local backend — the Ollama host is always configured", () => {
    expect(needsCredentialSetup({ backend: "local", hasAnthropicCredential: false })).toBe(false);
  });
});
