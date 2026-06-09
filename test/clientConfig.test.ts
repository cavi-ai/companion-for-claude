import { describe, it, expect } from "vitest";
import { generateToken, bridgeUrl, claudeCodeCommand, claudeDesktopConfig, maskToken, resolveMcpToken, mcpTokenEnvRef, MCP_TOKEN_ENV } from "../src/mcp/clientConfig";

describe("maskToken", () => {
  it("keeps a short prefix/suffix and masks the middle", () => {
    expect(maskToken("abcdef0123456789wxyz")).toBe("abcd••••••••••••wxyz");
  });
  it("fully masks short tokens and handles empty", () => {
    expect(maskToken("abc")).toBe("•••");
    expect(maskToken("")).toBe("");
  });
});

describe("resolveMcpToken", () => {
  it("prefers the env var over the stored token", () => {
    expect(resolveMcpToken({ [MCP_TOKEN_ENV]: "envtok" }, "stored")).toEqual({ token: "envtok", source: "env" });
  });
  it("falls back to stored, then none", () => {
    expect(resolveMcpToken({}, "stored")).toEqual({ token: "stored", source: "stored" });
    expect(resolveMcpToken({}, "  ")).toEqual({ token: "", source: "none" });
  });
  it("exposes a share-safe env reference", () => {
    expect(mcpTokenEnvRef()).toBe("${OBSIDIAN_COMPANION_MCP_TOKEN}");
  });
});

describe("generateToken", () => {
  it("produces a hex string of the expected length", () => {
    expect(generateToken(24)).toMatch(/^[0-9a-f]{48}$/);
  });
  it("produces distinct tokens", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("bridgeUrl", () => {
  it("binds to loopback with the /mcp path", () => {
    expect(bridgeUrl(22360)).toBe("http://127.0.0.1:22360/mcp");
  });
});

describe("claudeCodeCommand", () => {
  it("includes the http transport, url, and auth header", () => {
    const cmd = claudeCodeCommand({ port: 22360, token: "abc" });
    expect(cmd).toContain("--transport http");
    expect(cmd).toContain("http://127.0.0.1:22360/mcp");
    expect(cmd).toContain('Authorization: Bearer abc');
  });
  it("requires a bearer token", () => {
    expect(() => claudeCodeCommand({ port: 22360, token: "" })).toThrow(/token/i);
  });
});

describe("claudeDesktopConfig", () => {
  it("emits valid JSON with an mcp-remote command and bearer header", () => {
    const cfg = JSON.parse(claudeDesktopConfig({ port: 22360, token: "abc" }));
    const server = cfg.mcpServers["obsidian-vault"];
    expect(server.command).toBe("npx");
    expect(server.args).toContain("mcp-remote");
    expect(server.args).toContain("http://127.0.0.1:22360/mcp");
    expect(server.args.join(" ")).toContain("Authorization: Bearer abc");
  });
  it("requires a bearer token", () => {
    expect(() => claudeDesktopConfig({ port: 22360, token: "" })).toThrow(/token/i);
  });
});
