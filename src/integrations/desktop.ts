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
}

export interface ClaudeCodeInspection {
  claude: ProbeResult;
  obsidian: ProbeResult;
  marketplaceInstalled: boolean;
  pluginInstalled: boolean;
  pluginEnabled: boolean;
}

export interface ClaudeCodePluginState {
  id: string;
  enabled: boolean;
}

export interface ClaudeDesktopServer {
  command: string;
  args: string[];
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    return { id: entry.id, enabled: entry.enabled };
  });
}

export function claudeCodeSetupPlan(state: ClaudeCodeInspection, platform: DesktopPlatform = "unsupported"): CommandSpec[] {
  if (!state.claude.available) throw new DesktopIntegrationError("Set up Claude Code", "Claude Code is not available.");
  if (!state.obsidian.available) {
    throw new DesktopIntegrationError(
      "Set up Claude Code",
      state.obsidian.state === "unreachable"
        ? OBSIDIAN_CLI_UNREACHABLE
        : `The Obsidian CLI is not installed. ${obsidianCliInstallHint(platform)}`,
    );
  }
  if (state.pluginInstalled && state.pluginEnabled) return [];
  const commands: CommandSpec[] = [];
  if (!state.marketplaceInstalled) {
    commands.push({
      executable: "claude",
      args: ["plugin", "marketplace", "add", MARKETPLACE_REPO],
      stage: "Add the CAVI marketplace",
    });
  }
  commands.push(state.pluginInstalled
    ? {
        executable: "claude",
        args: ["plugin", "enable", OBSIDIAN_AGENT_PLUGIN_ID, "--scope", "user"],
        stage: "Enable obsidian-agent",
      }
    : {
        executable: "claude",
        args: ["plugin", "install", OBSIDIAN_AGENT_PLUGIN_ID, "--scope", "user"],
        stage: "Install obsidian-agent",
      });
  return commands;
}

export function mergeClaudeDesktopConfig(source: string | null, server: ClaudeDesktopServer): string {
  let root: Record<string, unknown> = {};
  if (source?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new DesktopIntegrationError("Configure Claude Desktop", "Claude Desktop configuration contains malformed JSON.");
    }
    if (!isRecord(parsed)) {
      throw new DesktopIntegrationError("Configure Claude Desktop", "Claude Desktop configuration must be a JSON object.");
    }
    root = { ...parsed };
  }

  const currentServers = root.mcpServers;
  if (currentServers !== undefined && !isRecord(currentServers)) {
    throw new DesktopIntegrationError("Configure Claude Desktop", "Claude Desktop mcpServers must be a JSON object.");
  }
  root.mcpServers = {
    ...(currentServers ?? {}),
    "obsidian-vault": { command: server.command, args: [...server.args] },
  };
  return `${JSON.stringify(root, null, 2)}\n`;
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
