// Pure argv for the Claude Code CLI chat backend. Every flag here is load-bearing for security.

export const CLI_MCP_SERVER = "obsidian-vault";
export const CLI_PERMISSION_TOOL = "permission_prompt";
export const CLI_PROPOSE_EDIT_TOOL = "propose_note_edit";

const PREFIX = `mcp__${CLI_MCP_SERVER}__`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cliToolName(tool: string): string {
  return `${PREFIX}${tool}`;
}

export function stripCliToolName(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

export function mcpConfigJson(port: number, token: string): string {
  return JSON.stringify({
    mcpServers: { [CLI_MCP_SERVER]: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
  });
}

export interface CliArgvInput {
  model: string;
  systemPromptFile: string;
  mcpConfigJson: string;
  /** Exact bridge tool names; auto-approved. Writes stay off this list so they route to the permission tool. */
  allowedTools: string[];
  maxTurns: number;
  sessionId: string;
}

export function buildClaudeArgv(i: CliArgvInput): string[] {
  for (const t of i.allowedTools) {
    if (t.includes("*") || !t.startsWith(PREFIX)) throw new Error(`allowedTools must name bridge tools exactly: ${t}`);
  }
  if (!UUID.test(i.sessionId)) throw new Error("sessionId must be a UUID");
  if (!Number.isInteger(i.maxTurns) || i.maxTurns < 1) throw new Error("maxTurns must be a positive integer");
  return [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--permission-mode", "default",
    "--max-turns", String(i.maxTurns),
    "--model", i.model,
    "--append-system-prompt-file", i.systemPromptFile,
    "--mcp-config", i.mcpConfigJson,
    "--permission-prompt-tool", cliToolName(CLI_PERMISSION_TOOL),
    "--session-id", i.sessionId,
    ...(i.allowedTools.length > 0 ? ["--allowedTools", i.allowedTools.join(",")] : []),
  ];
}
