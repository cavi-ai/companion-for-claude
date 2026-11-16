// Agent CLIs that take Companion's vault tools as an MCP server. Each one gets
// obsidian-vault in the vault's own config file, never the CLI's user config,
// so the tools load only in this vault. The entry runs the connector script
// with this vault's connection file, so no token lands in the vault and a
// changed port or token needs no new registration. Pure.

import { isRecord } from "../records";
import { DesktopIntegrationError, type DesktopPlatform, type ProbeResult } from "./desktop";

export type CliHost = "codex" | "agy";
export const CLI_HOSTS: readonly CliHost[] = ["codex", "agy"];
export const CLI_HOST_LABELS: Record<CliHost, string> = { codex: "Codex", agy: "Antigravity" };
/** The MCP server name each CLI registers. */
export const VAULT_SERVER_NAME = "obsidian-vault";

/** Each CLI's workspace config, relative to the vault: Codex loads it once the vault folder is trusted. */
export const CLI_HOST_CONFIG_FILES: Record<CliHost, readonly [string, string]> = {
  codex: [".codex", "config.toml"],
  agy: [".agents", "mcp_config.json"],
};

export interface CliHostInspection {
  host: CliHost;
  probe: ProbeResult;
  /** This vault's config file holds the current obsidian-vault entry. */
  registered: boolean;
}

/** The connector the vault's entry runs: the script and this vault's connection file. */
export interface VaultConnector {
  scriptPath: string;
  connectionPath: string;
}

/** PATH inside Obsidian is not the shell's, so the documented install locations are tried by absolute path too. */
export function cliHostCandidates(host: CliHost, platform: DesktopPlatform, homeDir: string): string[] {
  if (platform === "win32") return [host];
  return [host, `${homeDir}/.local/bin/${host}`, `/opt/homebrew/bin/${host}`, `/usr/local/bin/${host}`];
}

/** `codex --version` prints `codex-cli 0.162.1`; `agy --version` prints `1.4.3`. */
export function parseCliVersion(stdout: string): ProbeResult {
  const version = /(\d+\.\d+\.\d+)/.exec(stdout.split(/\r?\n/, 1)[0] ?? "")?.[1];
  if (!version) throw new DesktopIntegrationError("Check agent CLI", "The CLI did not report a version.");
  return { available: true, state: "available", version };
}

/** The CLI's config file inside the vault. */
export function cliHostConfigPath(host: CliHost, vaultPath: string, platform: DesktopPlatform): string {
  const separator = platform === "win32" ? "\\" : "/";
  return [vaultPath.replace(/[\\/]+$/, ""), ...CLI_HOST_CONFIG_FILES[host]].join(separator);
}

const CODEX_TABLE = `[mcp_servers.${VAULT_SERVER_NAME}]`;
const CODEX_SUBTABLE = `[mcp_servers.${VAULT_SERVER_NAME}.`;

function codexBlock(connector: VaultConnector): string[] {
  return [
    CODEX_TABLE,
    `command = "node"`,
    `args = [${JSON.stringify(connector.scriptPath)}, ${JSON.stringify(connector.connectionPath)}]`,
  ];
}

/** The lines outside obsidian-vault's tables, and the body of its main table (null when absent). */
function splitCodex(source: string): { rest: string[]; table: string[] | null } {
  const rest: string[] = [];
  let table: string[] | null = null;
  let inOwn = false;
  let inMain = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inOwn = trimmed === CODEX_TABLE || trimmed.startsWith(CODEX_SUBTABLE);
      inMain = trimmed === CODEX_TABLE;
      if (inMain) table = [];
      if (inOwn) continue;
    }
    if (!inOwn) rest.push(line);
    else if (inMain && trimmed) table?.push(trimmed);
  }
  return { rest, table };
}

function jsonServer(source: string | null, path: string): { config: Record<string, unknown>; servers: Record<string, unknown> } {
  if (!source?.trim()) return { config: {}, servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new DesktopIntegrationError("Connect Antigravity", `${path} is not valid JSON. Fix or remove it, then connect again.`);
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new DesktopIntegrationError("Connect Antigravity", `${path} does not hold an mcpServers object. Fix or remove it, then connect again.`);
  }
  return { config: parsed, servers: isRecord(parsed.mcpServers) ? parsed.mcpServers : {} };
}

/** Whether a `{ mcpServers }` JSON file's obsidian-vault entry runs this connector. Unreadable counts as absent. */
export function jsonServerRunsConnector(source: string | null, connector: VaultConnector): boolean {
  let entry: unknown;
  try {
    entry = jsonServer(source, "").servers[VAULT_SERVER_NAME];
  } catch {
    return false;
  }
  return isRecord(entry)
    && entry.command === "node"
    && Array.isArray(entry.args)
    && entry.args.length === 2
    && entry.args[0] === connector.scriptPath
    && entry.args[1] === connector.connectionPath;
}

/** The vault config file with obsidian-vault set to this connector and every other entry kept. */
export function cliHostConfigBody(host: CliHost, source: string | null, connector: VaultConnector, path: string): string {
  if (host === "codex") {
    const rest = splitCodex(source ?? "").rest;
    while (rest.length > 0 && !rest[rest.length - 1]?.trim()) rest.pop();
    return `${[...rest, ...(rest.length > 0 ? [""] : []), ...codexBlock(connector)].join("\n")}\n`;
  }
  const { config, servers } = jsonServer(source, path);
  const next = { ...config, mcpServers: { ...servers, [VAULT_SERVER_NAME]: { command: "node", args: [connector.scriptPath, connector.connectionPath] } } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** Whether the vault config file already runs this connector as obsidian-vault. */
export function cliHostConfigured(host: CliHost, source: string | null, connector: VaultConnector): boolean {
  if (host === "agy") return jsonServerRunsConnector(source, connector);
  const table = splitCodex(source ?? "").table;
  const expected = codexBlock(connector).slice(1);
  return table !== null && table.length === expected.length && table.every((line, i) => line === expected[i]);
}
