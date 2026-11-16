import { describe, expect, it } from "vitest";
import {
  DesktopIntegrationError,
  MARKETPLACE_NAME,
  MARKETPLACE_REPO,
  OBSIDIAN_AGENT_PLUGIN_ID,
  claudeCodeSetupPlan,
  parseClaudeVersion,
  parseMarketplaceList,
  parsePluginList,
  sanitizeDesktopError,
  vaultPluginInstall,
  type ClaudeCodeInspection,
} from "../../src/integrations/desktop";

const inspection = (overrides: Partial<ClaudeCodeInspection> = {}): ClaudeCodeInspection => ({
  claude: { available: true, state: "available", version: "2.1.226" },
  obsidian: { available: true, state: "available", version: "1.12.7" },
  marketplaceInstalled: false,
  pluginInstalled: false,
  pluginEnabled: false,
  bridge: { enabled: false, registered: false },
  ...overrides,
});

const target = { vaultPath: "/v/Notes", scriptPath: "/c/server/index.js", connectionPath: "/c/vaults/Notes-1/bridge.json" };
const plan = (state: ClaudeCodeInspection) => claudeCodeSetupPlan(state, "unsupported", target);

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

  it("parses current plugin JSON with enabled state, scope and project folder", () => {
    expect(parsePluginList(JSON.stringify([
      { id: "obsidian-agent@cavi-ai", version: "0.1.0", scope: "user", enabled: true, projectPath: null, future: "ok" },
      { id: "obsidian-agent@cavi-ai", scope: "project", enabled: true, projectPath: "/v/Notes" },
      { id: "remember@claude-plugins-official", enabled: false },
    ]))).toEqual([
      { id: "obsidian-agent@cavi-ai", enabled: true, scope: "user" },
      { id: "obsidian-agent@cavi-ai", enabled: true, scope: "project", projectPath: "/v/Notes" },
      { id: "remember@claude-plugins-official", enabled: false },
    ]);
  });

  it("counts only a project or local install recorded for this vault as the vault's", () => {
    const plugins = [
      { id: OBSIDIAN_AGENT_PLUGIN_ID, enabled: true, scope: "user" },
      { id: OBSIDIAN_AGENT_PLUGIN_ID, enabled: true, scope: "project", projectPath: "/v/Other" },
    ];
    expect(vaultPluginInstall(plugins, OBSIDIAN_AGENT_PLUGIN_ID, "/v/Notes")).toBeUndefined();
    const local = { id: OBSIDIAN_AGENT_PLUGIN_ID, enabled: false, scope: "local", projectPath: "/v/Notes/" };
    expect(vaultPluginInstall([...plugins, local], OBSIDIAN_AGENT_PLUGIN_ID, "/v/Notes")).toBe(local);
  });

  it.each(["{}", "null", "42", "[null]", "[{\"name\":42}]"])("rejects malformed marketplace JSON: %s", (body) => {
    expect(() => parseMarketplaceList(body)).toThrowError(DesktopIntegrationError);
  });

  it.each(["{}", "null", "false", "[null]", "[{\"id\":[]}]"])("rejects malformed plugin JSON: %s", (body) => {
    expect(() => parsePluginList(body)).toThrowError(DesktopIntegrationError);
  });

  it("plans only the missing Claude Code setup steps, each project-scoped in the vault", () => {
    const cwd = "/v/Notes";
    expect(plan(inspection())).toEqual([
      { executable: "claude", args: ["plugin", "marketplace", "add", "cavi-ai/plugins", "--scope", "project"], stage: "Add the CAVI marketplace", cwd },
      { executable: "claude", args: ["plugin", "install", "obsidian-agent@cavi-ai", "--scope", "project"], stage: "Install obsidian-agent", cwd },
    ]);
    expect(plan(inspection({ marketplaceInstalled: true }))).toEqual([
      { executable: "claude", args: ["plugin", "install", "obsidian-agent@cavi-ai", "--scope", "project"], stage: "Install obsidian-agent", cwd },
    ]);
    expect(plan(inspection({ marketplaceInstalled: true, pluginInstalled: true }))).toEqual([
      { executable: "claude", args: ["plugin", "enable", "obsidian-agent@cavi-ai", "--scope", "project"], stage: "Enable obsidian-agent", cwd },
    ]);
    expect(plan(inspection({ marketplaceInstalled: true, pluginInstalled: true, pluginEnabled: true }))).toEqual([]);
  });

  it("refuses to plan without a vault folder to write into", () => {
    expect(() => claudeCodeSetupPlan(inspection())).toThrow("no folder on disk");
  });

  it("connects Companion's vault tools in the vault's .mcp.json through this vault's connector", () => {
    expect(plan(inspection({ marketplaceInstalled: true, pluginInstalled: true, pluginEnabled: true, bridge: { enabled: true, registered: false } }))).toEqual([
      {
        executable: "claude",
        args: ["mcp", "add", "--scope", "project", "obsidian-vault", "--", "node", "/c/server/index.js", "/c/vaults/Notes-1/bridge.json"],
        stage: "Connect Companion's vault tools",
        cwd: "/v/Notes",
      },
    ]);
  });

  it("adds no bridge step once Companion's vault tools are already registered", () => {
    expect(plan(inspection({ marketplaceInstalled: true, pluginInstalled: true, pluginEnabled: true, bridge: { enabled: true, registered: true } }))).toEqual([]);
  });

  it("adds no bridge step while the MCP bridge is turned off", () => {
    expect(plan(inspection({ marketplaceInstalled: true, pluginInstalled: true, pluginEnabled: true, bridge: { enabled: false, registered: false } }))).toEqual([]);
  });

  it("installs from the marketplace name the published catalog declares", () => {
    expect(MARKETPLACE_REPO).toBe("cavi-ai/plugins");
    expect(MARKETPLACE_NAME).toBe("cavi-ai");
    expect(OBSIDIAN_AGENT_PLUGIN_ID).toBe(`obsidian-agent@${MARKETPLACE_NAME}`);
    const [add, install] = plan(inspection());
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
