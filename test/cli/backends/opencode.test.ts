import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeBackend, buildOpencodeArgv, opencodeEnv, parseOpencodeLine } from "../../../src/cli/backends/opencode";
import { mcpConfigJson } from "../../../src/cli/argv";

const input = {
  model: "anthropic/claude-sonnet-5",
  systemPromptFile: "/tmp/cc-prompt.md",
  mcpConfigJson: mcpConfigJson(51234, "tok"),
  allowedTools: [],
  maxTurns: 10,
  cwd: "/tmp/vault",
};

function fixture(name: string): string[] {
  return readFileSync(join(__dirname, "../../fixtures/cli", name), "utf8").trim().split("\n");
}

describe("buildOpencodeArgv", () => {
  it("runs `run --format json` scoped to --dir, --pure (no external plugins)", () => {
    const argv = buildOpencodeArgv(input);
    expect(argv.slice(0, 5)).toEqual(["run", "--format", "json", "--dir", "/tmp/vault"]);
    expect(argv).toContain("--pure");
  });

  it("passes -m only when a model is set, and --session instead of a fresh session id", () => {
    expect(buildOpencodeArgv({ ...input, model: "" })).not.toContain("-m");
    expect(buildOpencodeArgv(input).slice(-2)).toEqual(["-m", "anthropic/claude-sonnet-5"]);
    const argv = buildOpencodeArgv({ ...input, resumeSessionId: "ses_1" });
    expect(argv.slice(-2)).toEqual(["--session", "ses_1"]);
  });
});

describe("opencodeEnv", () => {
  it("carries the vault MCP server as OPENCODE_CONFIG_CONTENT, matching the binary's own remote-server schema", () => {
    const env = opencodeEnv(input);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { "obsidian-vault": { type: "remote", url: "http://127.0.0.1:51234/mcp", headers: { Authorization: "Bearer tok" } } },
    });
  });
});

describe("parseOpencodeLine against the real opencode run --format json fixtures", () => {
  it("maps a text part to text and a stop step_finish to a success result (opencode-basic.jsonl)", () => {
    const events = fixture("opencode-basic.jsonl").flatMap(parseOpencodeLine);
    expect(events).toContainEqual({ kind: "text", delta: "ok" });
    expect(events).toContainEqual({ kind: "result", subtype: "success", text: "", sessionId: "ses_scrubbed", isError: false });
  });

  it("maps a completed tool_use part to toolUse+toolResult and ignores the mid-turn tool-calls step_finish (opencode-tool.jsonl)", () => {
    const events = fixture("opencode-tool.jsonl").flatMap(parseOpencodeLine);
    const use = events.find((e) => e.kind === "toolUse");
    const result = events.find((e) => e.kind === "toolResult");
    expect(use).toEqual({ kind: "toolUse", block: { type: "tool_use", id: "tool_scrubbed", name: "glob", input: { pattern: "*" } } });
    expect(result?.kind).toBe("toolResult");
    expect((result as { isError: boolean }).isError).toBe(false);
    expect(events.filter((e) => e.kind === "result")).toHaveLength(1); // only the final stop, not the tool-calls checkpoint
  });

  it("returns [] on malformed JSON", () => {
    expect(parseOpencodeLine("not json")).toEqual([]);
  });
});

describe("opencodeBackend.probe", () => {
  it("parses `opencode providers list` credential count (verified live against 4 real credentials)", async () => {
    const run = async () => ({ stdout: "└  4 credentials\n", code: 0 });
    expect(await opencodeBackend.probe(run)).toEqual({ loggedIn: true, method: "4 credentials" });
  });

  it("reports signed out with zero credentials or a non-zero exit", async () => {
    expect((await opencodeBackend.probe(async () => ({ stdout: "0 credentials", code: 0 }))).loggedIn).toBe(false);
    expect((await opencodeBackend.probe(async () => ({ stdout: "", code: 1 }))).loggedIn).toBe(false);
  });
});

describe("opencodeBackend metadata", () => {
  it("has no permission-prompt tool, so writes must gate in bridgeTools", () => {
    expect(opencodeBackend.supportsPermissionPrompt).toBe(false);
    expect(opencodeBackend.supportsMcp).toBe(true);
    expect(opencodeBackend.binary).toBe("opencode");
  });
});
