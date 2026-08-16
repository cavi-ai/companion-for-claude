import { describe, expect, it } from "vitest";
import {
  DesktopIntegrationError,
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  OBSIDIAN_AGENT_PLUGIN_ID,
  claudeCodeSetupPlan,
  mergeClaudeDesktopConfig,
  parseClaudeVersion,
  parseMarketplaceList,
  parsePluginList,
  sanitizeDesktopError,
  type ClaudeCodeInspection,
} from "../../src/integrations/desktop";

const inspection = (overrides: Partial<ClaudeCodeInspection> = {}): ClaudeCodeInspection => ({
  claude: { available: true, state: "available", version: "2.1.226" },
  obsidian: { available: true, state: "available", version: "1.12.7" },
  marketplaceInstalled: false,
  pluginInstalled: false,
  pluginEnabled: false,
  ...overrides,
});

describe("desktop integration contracts", () => {
  it("parses a callable Claude Code version without depending on exact release text", () => {
    expect(parseClaudeVersion("2.1.226 (Claude Code)\n")).toEqual({ available: true, state: "available", version: "2.1.226" });
  });

  it("rejects an empty Claude Code version", () => {
    expect(() => parseClaudeVersion(" \n")).toThrowError(DesktopIntegrationError);
  });

  it("parses current marketplace JSON and retains source identity", () => {
    expect(parseMarketplaceList(JSON.stringify([
      { name: "plugins", source: "github", repo: "cavi-ai/plugins", future: true },
      { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official" },
    ]))).toEqual(["plugins", "cavi-ai/plugins", "claude-plugins-official", "anthropics/claude-plugins-official"]);
  });

  it("parses current plugin JSON with enabled state", () => {
    expect(parsePluginList(JSON.stringify([
      { id: "obsidian-agent@cavi-ai", version: "0.1.0", scope: "user", enabled: true, future: "ok" },
      { id: "remember@claude-plugins-official", enabled: false },
    ]))).toEqual([
      { id: "obsidian-agent@cavi-ai", enabled: true },
      { id: "remember@claude-plugins-official", enabled: false },
    ]);
  });

  it.each(["{}", "null", "42", "[null]", "[{\"name\":42}]"])("rejects malformed marketplace JSON: %s", (body) => {
    expect(() => parseMarketplaceList(body)).toThrowError(DesktopIntegrationError);
  });

  it.each(["{}", "null", "false", "[null]", "[{\"id\":[]}]"])("rejects malformed plugin JSON: %s", (body) => {
    expect(() => parsePluginList(body)).toThrowError(DesktopIntegrationError);
  });

  it("plans only the missing Claude Code setup steps", () => {
    expect(claudeCodeSetupPlan(inspection())).toEqual([
      { executable: "claude", args: ["plugin", "marketplace", "add", "cavi-ai/plugins"], stage: "Add the CAVI marketplace" },
      { executable: "claude", args: ["plugin", "install", "obsidian-agent@cavi-ai", "--scope", "user"], stage: "Install obsidian-agent" },
    ]);
    expect(claudeCodeSetupPlan(inspection({ marketplaceInstalled: true }))).toEqual([
      { executable: "claude", args: ["plugin", "install", "obsidian-agent@cavi-ai", "--scope", "user"], stage: "Install obsidian-agent" },
    ]);
    expect(claudeCodeSetupPlan(inspection({ marketplaceInstalled: true, pluginInstalled: true }))).toEqual([
      { executable: "claude", args: ["plugin", "enable", "obsidian-agent@cavi-ai", "--scope", "user"], stage: "Enable obsidian-agent" },
    ]);
    expect(claudeCodeSetupPlan(inspection({ marketplaceInstalled: true, pluginInstalled: true, pluginEnabled: true }))).toEqual([]);
  });

  it("installs from the marketplace name the published catalog declares", () => {
    expect(MARKETPLACE_REPO).toBe("cavi-ai/plugins");
    expect(MARKETPLACE_NAME).toBe("cavi-ai");
    expect(OBSIDIAN_AGENT_PLUGIN_ID).toBe(`obsidian-agent@${MARKETPLACE_NAME}`);
    const [add, install] = claudeCodeSetupPlan(inspection());
    expect(add?.args).toContain(MARKETPLACE_REPO);
    expect(install?.args).toContain(OBSIDIAN_AGENT_PLUGIN_ID);
  });

  it("refuses setup plans until both desktop CLIs are callable", () => {
    expect(() => claudeCodeSetupPlan(inspection({ claude: { available: false, state: "missing" } }))).toThrow("Claude Code is not available");
    expect(() => claudeCodeSetupPlan(inspection({ obsidian: { available: false, state: "missing" } }))).toThrow("The Obsidian CLI is not installed");
  });

  // "not found" for a CLI that is installed but cannot reach Obsidian points the
  // user at reinstalling something they already have.
  it("tells an unreachable Obsidian CLI apart from a missing one", () => {
    expect(() => claudeCodeSetupPlan(inspection({ obsidian: { available: false, state: "unreachable" } })))
      .toThrow("could not reach Obsidian");
    expect(() => claudeCodeSetupPlan(inspection({ obsidian: { available: false, state: "unreachable" } })))
      .not.toThrow("not installed");
  });

  it("names the platform's own registration target when the CLI is missing", () => {
    expect(() => claudeCodeSetupPlan(inspection({ obsidian: { available: false, state: "missing" } }), "darwin"))
      .toThrow("/usr/local/bin/obsidian");
    expect(() => claudeCodeSetupPlan(inspection({ obsidian: { available: false, state: "missing" } }), "linux"))
      .toThrow("~/.local/bin/obsidian");
  });

  it("preserves unrelated Claude Desktop configuration", () => {
    const merged = JSON.parse(mergeClaudeDesktopConfig(JSON.stringify({
      theme: "dark",
      mcpServers: { zotero: { command: "zotero-mcp" } },
    }), {
      command: "npx",
      args: ["-y", "mcp-remote", "http://127.0.0.1:22360/mcp", "--header", "Authorization: Bearer secret"],
    }));
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.zotero).toEqual({ command: "zotero-mcp" });
    expect(merged.mcpServers["obsidian-vault"].command).toBe("npx");
  });

  it("creates stable configuration for an absent or empty Claude Desktop file", () => {
    const server = { command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:22360/mcp"] };
    expect(mergeClaudeDesktopConfig(null, server)).toBe(`${JSON.stringify({ mcpServers: { "obsidian-vault": server } }, null, 2)}\n`);
    expect(mergeClaudeDesktopConfig("  \n", server)).toBe(mergeClaudeDesktopConfig(null, server));
  });

  it.each(["{", "null", "[]", "1", "true", "{\"mcpServers\":[]}"])("refuses unsafe Claude Desktop config: %s", (body) => {
    expect(() => mergeClaudeDesktopConfig(body, { command: "npx", args: [] })).toThrowError(DesktopIntegrationError);
  });

  it("replaces only the owned Claude Desktop server entry", () => {
    const merged = JSON.parse(mergeClaudeDesktopConfig(JSON.stringify({
      mcpServers: { "obsidian-vault": { command: "old" }, keep: { command: "keep" } },
    }), { command: "npx", args: ["new"] }));
    expect(merged.mcpServers).toEqual({
      "obsidian-vault": { command: "npx", args: ["new"] },
      keep: { command: "keep" },
    });
  });

  it("redacts bearer credentials, supplied secrets, and bounds external errors", () => {
    const secret = "sk-ant-private-value";
    const message = `request failed Authorization: Bearer ${secret}; token=${secret}; ${"x".repeat(900)}`;
    const sanitized = sanitizeDesktopError(message, [secret]);
    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toMatch(/Bearer\s+\S+/i);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized.length).toBeLessThanOrEqual(603);
  });
});
