import { isRecord } from "../records";

export type DesktopPlatform = "darwin" | "win32" | "linux" | "unsupported";

/** The published CAVI catalog: the repo `marketplace add` takes. */
export const MARKETPLACE_REPO = "cavi-ai/plugins";
/** The name that repo's marketplace.json declares — what follows `@` on install. */
export const MARKETPLACE_NAME = "cavi-ai";
/** The plugin id to install and enable. */
export const OBSIDIAN_AGENT_PLUGIN_ID = `obsidian-agent@${MARKETPLACE_NAME}`;

/**
 * `missing` means no candidate path exists; `unreachable` means one ran and
 * failed. Collapsing the two reports an installed binary as "not found", which
 * points the user at the wrong fix.
 */
export type ProbeState = "available" | "missing" | "unreachable";

export interface ProbeResult {
  available: boolean;
  state: ProbeState;
  version?: string;
  message?: string;
  /** The candidate that ran, when one did. */
  executable?: string;
}

/** The Obsidian settings tab that carries the CLI switch. */
export const OBSIDIAN_GENERAL_SETTINGS_TAB = "about";

/**
 * Obsidian owns both steps: a “Command line interface” switch, then a separate
 * “Set up CLI to work in the terminal” → Register that elevates to place the
 * command. Companion cannot do either, so it routes the user to them.
 */
export function obsidianCliInstallHint(platform: DesktopPlatform): string {
  const enable = "In Obsidian 1.12.7 or later, turn on Settings → General → “Command line interface”, "
    + "then use “Set up CLI to work in the terminal” → Register";
  if (platform === "darwin") return `${enable}. Registering asks for your password and links /usr/local/bin/obsidian.`;
  if (platform === "linux") return `${enable}. Registering places the command at ~/.local/bin/obsidian.`;
  if (platform === "win32") return `${enable}. Registering adds the Obsidian folder to your user PATH.`;
  return `${enable}.`;
}

/** The CLI answers only while Obsidian is reachable; a stale socket looks like this. */
export const OBSIDIAN_CLI_UNREACHABLE =
  "The Obsidian CLI is installed but could not reach Obsidian. Restart Obsidian, or turn "
  + "Settings → General → “Command line interface” off and on again.";

export interface CommandSpec {
  executable: string;
  args: string[];
  stage: string;
  /** The folder the command runs in: the vault, for every project-scoped step. */
  cwd?: string;
}

/** Companion's MCP bridge as this vault's Claude Code project sees it. */
export interface BridgeSetupState {
  enabled: boolean;
  /** This vault's `.mcp.json` runs this vault's connector as obsidian-vault. */
  registered: boolean;
}

/** Where Claude Code setup writes: the vault folder, and the connector its `.mcp.json` entry runs. */
export interface ClaudeCodeTarget {
  vaultPath: string;
  scriptPath: string;
  connectionPath: string;
}

export interface ClaudeCodeInspection {
  claude: ProbeResult;
  obsidian: ProbeResult;
  marketplaceInstalled: boolean;
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  bridge: BridgeSetupState;
}

export interface ClaudeCodePluginState {
  id: string;
  enabled: boolean;
  /** `user`, `project` or `local`, as Claude Code reports it. */
  scope?: string;
  /** The project folder a `project` or `local` install belongs to. */
  projectPath?: string;
}

export class DesktopIntegrationError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "DesktopIntegrationError";
  }
}

export function claudeDesktopConfigPath(
  platform: DesktopPlatform,
  homeDir: string,
  env: Record<string, string | undefined>,
): string {
  if (platform === "darwin") return `${homeDir}/Library/Application Support/Claude/claude_desktop_config.json`;
  if (platform === "win32") {
    const appData = env.APPDATA?.replace(/[\\/]+$/, "") || `${homeDir}\\AppData\\Roaming`;
    return `${appData}\\Claude\\claude_desktop_config.json`;
  }
  throw new DesktopIntegrationError("Configure Claude Desktop", "Automatic Claude Desktop setup is not supported on this platform.");
}

function parseJsonArray(body: string, stage: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new DesktopIntegrationError(stage, `${stage} returned malformed JSON.`);
  }
  if (!Array.isArray(parsed)) throw new DesktopIntegrationError(stage, `${stage} returned an unexpected response.`);
  return parsed;
}

export function parseClaudeVersion(stdout: string): ProbeResult {
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(firstLine);
  if (!match?.[1]) throw new DesktopIntegrationError("Check Claude Code", "Claude Code did not report a version.");
  return { available: true, state: "available", version: match[1] };
}

export function parseMarketplaceList(stdout: string): string[] {
  const values: string[] = [];
  for (const entry of parseJsonArray(stdout, "Check Claude Code marketplaces")) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new DesktopIntegrationError("Check Claude Code marketplaces", "Claude Code returned an invalid marketplace entry.");
    }
    values.push(entry.name);
    if (typeof entry.repo === "string" && entry.repo.trim() !== "") values.push(entry.repo);
  }
  return values;
}

export function parsePluginList(stdout: string): ClaudeCodePluginState[] {
  return parseJsonArray(stdout, "Check Claude Code plugins").map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "" || typeof entry.enabled !== "boolean") {
      throw new DesktopIntegrationError("Check Claude Code plugins", "Claude Code returned an invalid plugin entry.");
    }
    return {
      id: entry.id,
      enabled: entry.enabled,
      ...(typeof entry.scope === "string" ? { scope: entry.scope } : {}),
      ...(typeof entry.projectPath === "string" ? { projectPath: entry.projectPath } : {}),
    };
  });
}

const trimSeparators = (path: string): string => path.replace(/[\\/]+$/, "");

/**
 * The install of `pluginId` that belongs to this vault: a `project` or `local`
 * install recorded for the vault folder. A `user` install loads in every folder,
 * so it never counts as this vault's.
 */
export function vaultPluginInstall(plugins: ClaudeCodePluginState[], pluginId: string, vaultPath: string): ClaudeCodePluginState | undefined {
  const vault = trimSeparators(vaultPath);
  return plugins.find((plugin) => plugin.id === pluginId
    && (plugin.scope === "project" || plugin.scope === "local")
    && plugin.projectPath !== undefined
    && trimSeparators(plugin.projectPath) === vault);
}

/**
 * Every step is project-scoped and runs in the vault, so Claude Code writes the
 * vault's own `.claude/settings.json` and `.mcp.json` and nothing user-wide.
 */
export function claudeCodeSetupPlan(state: ClaudeCodeInspection, platform: DesktopPlatform = "unsupported", target?: ClaudeCodeTarget): CommandSpec[] {
  if (!state.claude.available) throw new DesktopIntegrationError("Set up Claude Code", "Claude Code is not available.");
  if (!state.obsidian.available) {
    throw new DesktopIntegrationError(
      "Set up Claude Code",
      state.obsidian.state === "unreachable"
        ? OBSIDIAN_CLI_UNREACHABLE
        : `The Obsidian CLI is not installed. ${obsidianCliInstallHint(platform)}`,
    );
  }
  if (!target) throw new DesktopIntegrationError("Set up Claude Code", "This vault has no folder on disk to set up Claude Code in.");
  const cwd = target.vaultPath;
  const commands: CommandSpec[] = [];
  if (!(state.pluginInstalled && state.pluginEnabled)) {
    if (!state.marketplaceInstalled) {
      commands.push({
        executable: "claude",
        args: ["plugin", "marketplace", "add", MARKETPLACE_REPO, "--scope", "project"],
        stage: "Add the CAVI marketplace",
        cwd,
      });
    }
    commands.push(state.pluginInstalled
      ? {
          executable: "claude",
          args: ["plugin", "enable", OBSIDIAN_AGENT_PLUGIN_ID, "--scope", "project"],
          stage: "Enable obsidian-agent",
          cwd,
        }
      : {
          executable: "claude",
          args: ["plugin", "install", OBSIDIAN_AGENT_PLUGIN_ID, "--scope", "project"],
          stage: "Install obsidian-agent",
          cwd,
        });
  }
  if (state.bridge.enabled && !state.bridge.registered) {
    commands.push({
      executable: "claude",
      args: ["mcp", "add", "--scope", "project", "obsidian-vault", "--", "node", target.scriptPath, target.connectionPath],
      stage: "Connect Companion's vault tools",
      cwd,
    });
  }
  return commands;
}

export function sanitizeDesktopError(message: string, secrets: string[] = []): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  sanitized = sanitized
    .replace(/Authorization\s*:\s*Bearer\s+[^\s;,]+/gi, "Authorization: [redacted]")
    .replace(/\b(token|api[_-]?key|auth[_-]?token)\s*=\s*[^\s;,]+/gi, "$1=[redacted]")
    .trim();
  return sanitized.length > 600 ? `${sanitized.slice(0, 600)}...` : sanitized;
}
