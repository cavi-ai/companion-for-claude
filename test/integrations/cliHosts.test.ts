import { describe, expect, it } from "vitest";
import {
  cliHostCandidates,
  cliHostConfigBody,
  cliHostConfigPath,
  cliHostConfigured,
  parseCliVersion,
} from "../../src/integrations/cliHosts";

const connector = { scriptPath: "/c/server/index.js", connectionPath: "/c/vaults/Notes-1/bridge.json" };

describe("agent CLI hosts", () => {
  it("looks for each CLI on PATH and in its documented install folders", () => {
    expect(cliHostCandidates("agy", "darwin", "/Users/me")).toEqual(["agy", "/Users/me/.local/bin/agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
    expect(cliHostCandidates("codex", "win32", "C:\\Users\\me")).toEqual(["codex"]);
  });

  it("reads the version each CLI prints", () => {
    expect(parseCliVersion("codex-cli 0.162.1\n")).toEqual({ available: true, state: "available", version: "0.162.1" });
    expect(parseCliVersion("1.4.3\n").version).toBe("1.4.3");
    expect(() => parseCliVersion("usage: agy\n")).toThrow("did not report a version");
  });

  it("puts each CLI's config inside the vault", () => {
    expect(cliHostConfigPath("codex", "/v/Notes/", "darwin")).toBe("/v/Notes/.codex/config.toml");
    expect(cliHostConfigPath("agy", "C:\\v\\Notes", "win32")).toBe("C:\\v\\Notes\\.agents\\mcp_config.json");
  });

  it("replaces obsidian-vault's Codex tables and keeps the rest of the file", () => {
    const source = [
      'model = "o3"',
      "",
      "[mcp_servers.obsidian-vault]",
      'command = "npx"',
      "",
      "[mcp_servers.obsidian-vault.env]",
      'X = "1"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const body = cliHostConfigBody("codex", source, connector, "/v/.codex/config.toml");
    expect(body).toBe([
      'model = "o3"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[mcp_servers.obsidian-vault]",
      'command = "node"',
      'args = ["/c/server/index.js", "/c/vaults/Notes-1/bridge.json"]',
      "",
    ].join("\n"));
    expect(cliHostConfigBody("codex", body, connector, "")).toBe(body);
    expect(cliHostConfigBody("codex", null, connector, "")).toBe('[mcp_servers.obsidian-vault]\ncommand = "node"\nargs = ["/c/server/index.js", "/c/vaults/Notes-1/bridge.json"]\n');
  });

  it("sets obsidian-vault in Antigravity's mcpServers and refuses a file it cannot read as JSON", () => {
    const body = cliHostConfigBody("agy", JSON.stringify({ mcpServers: { keep: { command: "keep" } }, other: 1 }), connector, "/v/.agents/mcp_config.json");
    expect(JSON.parse(body)).toEqual({ mcpServers: { keep: { command: "keep" }, "obsidian-vault": { command: "node", args: [connector.scriptPath, connector.connectionPath] } }, other: 1 });
    expect(() => cliHostConfigBody("agy", "{", connector, "/v/.agents/mcp_config.json")).toThrow("/v/.agents/mcp_config.json is not valid JSON");
    expect(() => cliHostConfigBody("agy", "[]", connector, "/v/x.json")).toThrow("does not hold an mcpServers object");
  });

  it("counts a vault config as registered only when it runs this vault's connector", () => {
    const codex = cliHostConfigBody("codex", null, connector, "");
    expect(cliHostConfigured("codex", codex, connector)).toBe(true);
    expect(cliHostConfigured("codex", codex, { ...connector, connectionPath: "/c/vaults/Other-2/bridge.json" })).toBe(false);
    expect(cliHostConfigured("codex", 'model = "o3"\n', connector)).toBe(false);
    const agy = cliHostConfigBody("agy", null, connector, "");
    expect(cliHostConfigured("agy", agy, connector)).toBe(true);
    expect(cliHostConfigured("agy", "{", connector)).toBe(false);
    expect(cliHostConfigured("agy", null, connector)).toBe(false);
  });
});
