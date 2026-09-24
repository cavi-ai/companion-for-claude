// OpenCode CLI backend: one `opencode run --format json` process per turn; MCP config passed via OPENCODE_CONFIG_CONTENT env var, never a config file.

import { CLI_MCP_SERVER, parseMcpConfig } from "../argv";
import type { CliEvent } from "../streamJson";
import type { CliArgvInput, CliBackend } from "./types";

type Json = Record<string, unknown>;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export function buildOpencodeArgv(input: CliArgvInput): string[] {
  const argv = ["run", "--format", "json", "--dir", input.cwd, "--pure"];
  if (input.model) argv.push("-m", input.model);
  if (input.resumeSessionId) argv.push("--session", input.resumeSessionId);
  if (input.message !== undefined) argv.push(opencodePrompt(input));
  return argv;
}

/** The message, with the system prompt prepended when this is the first turn (opencode has no system-prompt-file flag). */
function opencodePrompt(input: CliArgvInput): string {
  return input.systemPromptText ? `${input.systemPromptText}\n\n${input.message ?? ""}` : input.message ?? "";
}

export function opencodeEnv(input: CliArgvInput): Record<string, string> {
  const { url, token } = parseMcpConfig(input.mcpConfigJson);
  const config = { mcp: { [CLI_MCP_SERVER]: { type: "remote", url, headers: { Authorization: `Bearer ${token}` } } } };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

export function parseOpencodeLine(line: string): CliEvent[] {
  let o: Json;
  try {
    o = obj(JSON.parse(line));
  } catch (e) {
    console.debug("Claude Companion: OpenCode event JSON parse failed", e);
    return [];
  }
  const part = obj(o.part);
  switch (o.type) {
    case "text":
      return [{ kind: "text", delta: str(part.text) }];
    case "tool_use": {
      const state = obj(part.state);
      const id = str(part.callID);
      const name = str(part.tool);
      const events: CliEvent[] = [{ kind: "toolUse", block: { type: "tool_use", id, name, input: obj(state.input) } }];
      if (state.status === "completed" || state.status === "error") {
        events.push({ kind: "toolResult", id, content: str(state.output), isError: state.status === "error" });
      }
      return events;
    }
    case "step_finish": {
      const reason = str(part.reason);
      if (reason === "tool-calls") return []; // more steps follow in this same process; not the turn's end
      if (reason === "stop") return [{ kind: "result", subtype: "success", text: "", sessionId: str(o.sessionID), isError: false }];
      return [{ kind: "result", subtype: reason || "unknown", text: "", sessionId: str(o.sessionID), isError: true }];
    }
    case "error":
      return [{ kind: "result", subtype: "error", text: str(obj(o.error).message, "OpenCode run failed"), sessionId: str(o.sessionID), isError: true }];
    default:
      return [];
  }
}

const CREDENTIAL_COUNT = /(\d+)\s+credentials?/i;

export const opencodeBackend: CliBackend = {
  id: "opencode-cli",
  label: "OpenCode",
  binary: "opencode",
  processModel: "per-turn",
  supportsPermissionPrompt: false,
  supportsMcp: true,
  signInHint: "run `opencode auth login`",
  async probe(run) {
    const { stdout, code } = await run(["providers", "list"]);
    if (code !== 0) return { loggedIn: false, method: "" };
    const match = CREDENTIAL_COUNT.exec(stdout);
    const count = match ? Number(match[1]) : 0;
    return { loggedIn: count > 0, method: count > 0 ? `${count} credential${count === 1 ? "" : "s"}` : "" };
  },
  buildArgv: buildOpencodeArgv,
  env: opencodeEnv,
  parseLine: parseOpencodeLine,
};
