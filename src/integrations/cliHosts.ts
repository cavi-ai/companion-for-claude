// Agent CLIs that take Companion's vault tools as an MCP server. Each one
// registers the connector script that sits beside the connection file through
// its own `mcp add`, so no token lands in its configuration and a changed port
// or token needs no new registration. Pure.

import { DesktopIntegrationError, type DesktopPlatform, type ProbeResult } from "./desktop";

export type CliHost = "codex" | "agy";
export const CLI_HOSTS: readonly CliHost[] = ["codex", "agy"];
export const CLI_HOST_LABELS: Record<CliHost, string> = { codex: "Codex", agy: "Antigravity" };
/** The MCP server name each CLI registers. */
export const VAULT_SERVER_NAME = "obsidian-vault";

export interface CliHostInspection {
  host: CliHost;
  probe: ProbeResult;
  /** obsidian-vault is in the CLI's MCP server list. */
  registered: boolean;
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

/** Registers obsidian-vault as `node <script>`; both CLIs replace an existing entry of the same name. */
export function cliHostRegisterArgs(host: CliHost, scriptPath: string): string[] {
  return host === "codex"
    ? ["mcp", "add", VAULT_SERVER_NAME, "--", "node", scriptPath]
    : ["mcp", "add", VAULT_SERVER_NAME, "node", scriptPath];
}

/** `codex mcp get <name>` exits non-zero when the server is not registered; `agy mcp list` prints one row per server. */
export function cliHostStatusArgs(host: CliHost): string[] {
  return host === "codex" ? ["mcp", "get", VAULT_SERVER_NAME] : ["mcp", "list"];
}

/** Whether a status command that exited 0 reports obsidian-vault. */
export function cliHostRegistered(host: CliHost, stdout: string): boolean {
  if (host === "codex") return true;
  return stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/, 1)[0] === VAULT_SERVER_NAME);
}
