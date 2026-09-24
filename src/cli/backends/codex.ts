// Codex CLI backend: one `codex exec` process per turn; MCP server injected with -c overrides, never via ~/.codex.

import { CLI_MCP_SERVER, parseMcpConfig } from "../argv";
import type { CliEvent } from "../streamJson";
import type { CliArgvInput, CliBackend } from "./types";

export const CODEX_MCP_TOKEN_ENV = "CLAUDE_COMPANION_CODEX_MCP_TOKEN";

type Json = Record<string, unknown>;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export function buildCodexArgv(input: CliArgvInput): string[] {
  const { url } = parseMcpConfig(input.mcpConfigJson);
  const argv = [
    "exec",
    "--json",
    "-C", input.cwd,
    "--sandbox", "read-only",
    "--ignore-user-config",
    "-c", `mcp_servers.${CLI_MCP_SERVER}.url="${url}"`,
    "-c", `mcp_servers.${CLI_MCP_SERVER}.bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}"`,
    // codex exec cancels any MCP call that needs approval; gatedWriteTools confirms writes on the bridge side.
    "-c", `mcp_servers.${CLI_MCP_SERVER}.default_tools_approval_mode="approve"`,
  ];
  if (input.model) argv.push("-m", input.model);
  if (input.resumeSessionId) argv.push("resume", input.resumeSessionId);
  if (input.message !== undefined) argv.push(codexPrompt(input));
  return argv;
}

/** The message, with the system prompt prepended when this is the first turn (codex has no system-prompt-file flag). */
function codexPrompt(input: CliArgvInput): string {
  return input.systemPromptText ? `${input.systemPromptText}\n\n${input.message ?? ""}` : input.message ?? "";
}

export function codexEnv(input: CliArgvInput): Record<string, string> {
  const { token } = parseMcpConfig(input.mcpConfigJson);
  return { [CODEX_MCP_TOKEN_ENV]: token };
}

export function parseCodexLine(line: string): CliEvent[] {
  let o: Json;
  try {
    o = obj(JSON.parse(line));
  } catch (e) {
    console.debug("Claude Companion: Codex event JSON parse failed", e);
    return [];
  }
  switch (o.type) {
    case "thread.started":
      return [{ kind: "init", sessionId: str(o.thread_id), model: "", tools: [], mcp: [] }];
    case "item.completed": {
      const item = obj(o.item);
      if (item.type === "agent_message") return [{ kind: "text", delta: str(item.text) }];
      if (item.type === "command_execution") {
        return [{ kind: "toolResult", id: str(item.id), content: str(item.aggregated_output), isError: num(item.exit_code) !== 0 }];
      }
      return [];
    }
    case "item.started": {
      const item = obj(o.item);
      if (item.type === "command_execution") {
        return [{ kind: "toolUse", block: { type: "tool_use", id: str(item.id), name: "shell", input: { command: str(item.command) } } }];
      }
      return [];
    }
    case "turn.completed": {
      const u = obj(o.usage);
      const input = num(u.input_tokens);
      const output = num(u.output_tokens);
      const usage = { ...(input !== undefined ? { input_tokens: input } : {}), ...(output !== undefined ? { output_tokens: output } : {}) };
      return [{ kind: "result", subtype: "success", text: "", sessionId: "", isError: false, ...(Object.keys(usage).length > 0 ? { usage } : {}) }];
    }
    case "turn.failed":
      return [{ kind: "result", subtype: "error", text: str(obj(o.error).message, "Codex turn failed"), sessionId: "", isError: true }];
    default:
      return [];
  }
}

export const codexBackend: CliBackend = {
  id: "codex-cli",
  label: "Codex",
  binary: "codex",
  processModel: "per-turn",
  supportsPermissionPrompt: false,
  supportsMcp: true,
  signInHint: "run `codex login`",
  async probe(run) {
    const { stdout, code } = await run(["login", "status"]);
    const loggedIn = code === 0 && /^logged in/i.test(stdout.trim());
    const method = /logged in using (.+)/i.exec(stdout)?.[1]?.trim() ?? "";
    return { loggedIn, method };
  },
  buildArgv: buildCodexArgv,
  env: codexEnv,
  parseLine: parseCodexLine,
};
