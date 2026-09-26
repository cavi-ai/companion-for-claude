import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexBackend, buildCodexArgv, codexEnv, parseCodexLine, CODEX_MCP_TOKEN_ENV } from "../../../src/cli/backends/codex";
import { mcpConfigJson } from "../../../src/cli/argv";

const input = {
  model: "gpt-5.1-codex",
  systemPromptFile: "/tmp/cc-prompt.md",
  mcpConfigJson: mcpConfigJson(51234, "tok"),
  allowedTools: [],
  maxTurns: 10,
  cwd: "/tmp/vault",
};

function fixture(name: string): string[] {
  return readFileSync(join(__dirname, "../../fixtures/cli", name), "utf8").trim().split("\n");
}

describe("buildCodexArgv", () => {
  it("runs exec --json in read-only sandbox, ignoring user config", () => {
    const argv = buildCodexArgv(input);
    expect(argv.slice(0, 3)).toEqual(["exec", "--json", "-C"]);
    expect(argv[argv.indexOf("-C") + 1]).toBe("/tmp/vault");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv).toContain("--ignore-user-config");
  });

  it("injects the vault MCP server as a streamable-http config override with the exact keys verified live", () => {
    const argv = buildCodexArgv(input);
    expect(argv).toContain('mcp_servers.obsidian-vault.url="http://127.0.0.1:51234/mcp"');
    expect(argv).toContain(`mcp_servers.obsidian-vault.bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}"`);
  });

  it("auto-approves bridge tool calls, since codex exec cancels any call that needs approval and the bridge gates writes itself", () => {
    expect(buildCodexArgv(input)).toContain('mcp_servers.obsidian-vault.default_tools_approval_mode="approve"');
  });

  it("passes -m only when a model is set, and resume instead of a fresh session id", () => {
    expect(buildCodexArgv({ ...input, model: "" })).not.toContain("-m");
    expect(buildCodexArgv(input)).toContain("-m");
    const argv = buildCodexArgv({ ...input, resumeSessionId: "thread-1" });
    expect(argv.slice(-2)).toEqual(["resume", "thread-1"]);
  });
});

describe("codexEnv", () => {
  it("carries the bearer token only via the env var named in argv, never inline", () => {
    expect(codexEnv(input)).toEqual({ [CODEX_MCP_TOKEN_ENV]: "tok" });
  });
});

describe("parseCodexLine against the real codex exec --json fixtures", () => {
  it("maps thread.started to init and agent_message to text (codex-basic.jsonl)", () => {
    const events = fixture("codex-basic.jsonl").flatMap(parseCodexLine);
    expect(events[0]).toEqual({ kind: "init", sessionId: "00000000-0000-0000-0000-000000000000", model: "", tools: [], mcp: [] });
    expect(events).toContainEqual({ kind: "text", delta: "ok" });
    expect(events.some((e) => e.kind === "result" && !e.isError)).toBe(true);
  });

  it("maps command_execution item.started/item.completed to toolUse/toolResult (codex-tool.jsonl)", () => {
    const events = fixture("codex-tool.jsonl").flatMap(parseCodexLine);
    const use = events.find((e) => e.kind === "toolUse");
    const result = events.find((e) => e.kind === "toolResult");
    expect(use).toEqual({ kind: "toolUse", block: { type: "tool_use", id: "item_2", name: "shell", input: { command: "/bin/zsh -lc ls" } } });
    expect(result).toEqual({ kind: "toolResult", id: "item_2", content: "note.txt\n", isError: false });
  });

  it("maps mcp_tool_call items to bridge tool chips (codex-mcp.jsonl, codex-cli 0.146.0)", () => {
    const events = fixture("codex-mcp.jsonl").flatMap(parseCodexLine);
    expect(events.find((e) => e.kind === "toolUse")).toEqual({ kind: "toolUse", block: { type: "tool_use", id: "item_1", name: "mcp__obsidian-vault__vault_ping", input: {} } });
    expect(events.find((e) => e.kind === "toolResult")).toEqual({ kind: "toolResult", id: "item_1", content: "PONG-7731", isError: false });
  });

  it("drops unrecognized item types instead of guessing at their shape", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "x", type: "reasoning", text: "thinking..." } });
    expect(parseCodexLine(line)).toEqual([]);
  });

  it("returns [] on malformed JSON", () => {
    expect(parseCodexLine("not json")).toEqual([]);
  });
});

describe("codexBackend.probe", () => {
  it("parses `codex login status` plain-text output (verified live: \"Logged in using ChatGPT\")", async () => {
    const run = async () => ({ stdout: "Logged in using ChatGPT\n", code: 0 });
    expect(await codexBackend.probe(run)).toEqual({ loggedIn: true, method: "ChatGPT" });
  });

  it("reads the status from stderr, where codex-cli 0.146 prints it", async () => {
    const run = async () => ({ stdout: "", stderr: "Logged in using ChatGPT\n", code: 0 });
    expect(await codexBackend.probe(run)).toEqual({ loggedIn: true, method: "ChatGPT" });
  });

  it("reports signed out on non-zero exit or unrecognized output", async () => {
    const run = async () => ({ stdout: "Not logged in\n", code: 0 });
    expect((await codexBackend.probe(run)).loggedIn).toBe(false);
  });
});

describe("codexBackend metadata", () => {
  it("has no permission-prompt tool, so writes must gate in bridgeTools", () => {
    expect(codexBackend.supportsPermissionPrompt).toBe(false);
    expect(codexBackend.supportsMcp).toBe(true);
    expect(codexBackend.binary).toBe("codex");
  });
});
