import { describe, it, expect } from "vitest";
import { claudeBackend } from "../../../src/cli/backends/claude";
import { buildClaudeArgv, cliToolName, mcpConfigJson } from "../../../src/cli/argv";

const input = {
  model: "claude-sonnet-5",
  systemPromptFile: "/tmp/cc-prompt.md",
  mcpConfigJson: mcpConfigJson(51234, "tok"),
  allowedTools: [cliToolName("vault_search")],
  maxTurns: 10,
  sessionId: "0f1e2d3c-4b5a-4968-8776-655443322110",
  cwd: "/tmp",
};

describe("claudeBackend", () => {
  it("buildArgv is byte-identical to buildClaudeArgv for the same input", () => {
    expect(claudeBackend.buildArgv(input)).toEqual(buildClaudeArgv(input));
  });

  it("declares id/label/binary and supports the permission-prompt tool", () => {
    expect(claudeBackend.id).toBe("claude-cli");
    expect(claudeBackend.label).toBe("Claude Code");
    expect(claudeBackend.binary).toBe("claude");
    expect(claudeBackend.supportsPermissionPrompt).toBe(true);
    expect(claudeBackend.supportsMcp).toBe(true);
  });

  it("parseLine delegates to parseCliLine unchanged", () => {
    const line = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } });
    expect(claudeBackend.parseLine(line)).toEqual([{ kind: "text", delta: "hi" }]);
  });

  it("probe reports signed-in status from `claude auth status` JSON", async () => {
    const run = async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }), code: 0 });
    expect(await claudeBackend.probe(run)).toEqual({ loggedIn: true, method: "oauth" });
  });
});
