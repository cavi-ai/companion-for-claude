import { describe, it, expect } from "vitest";
import { buildClaudeArgv, cliToolName, mcpConfigJson, stripCliToolName, CLI_PERMISSION_TOOL } from "../../src/cli/argv";

const input = {
  model: "claude-sonnet-5",
  systemPromptFile: "/tmp/cc-prompt.md",
  mcpConfigJson: mcpConfigJson(51234, "tok"),
  allowedTools: [cliToolName("vault_search"), cliToolName("note_read")],
  maxTurns: 10,
  sessionId: "0f1e2d3c-4b5a-4968-8776-655443322110",
};

describe("buildClaudeArgv", () => {
  it("emits the fixed print-mode flags in order, then the per-session flags", () => {
    const argv = buildClaudeArgv(input);
    expect(argv.slice(0, 15)).toEqual([
      "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages",
      "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--permission-mode", "default", "--max-turns",
    ]);
    expect(argv).toContain("--append-system-prompt-file");
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe("/tmp/cc-prompt.md");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(input.mcpConfigJson);
    expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe(`mcp__obsidian-vault__${CLI_PERMISSION_TOOL}`);
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(input.sessionId);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__obsidian-vault__vault_search,mcp__obsidian-vault__note_read");
  });

  it("never emits --bare, --resume, or a permissions bypass", () => {
    const argv = buildClaudeArgv(input);
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--resume");
    expect(argv.some((a) => a.includes("dangerously"))).toBe(false);
  });

  it("omits --allowedTools when nothing is allow-listed", () => {
    expect(buildClaudeArgv({ ...input, allowedTools: [] })).not.toContain("--allowedTools");
  });

  it("rejects wildcard or foreign allow-list entries", () => {
    expect(() => buildClaudeArgv({ ...input, allowedTools: ["mcp__obsidian-vault__*"] })).toThrow(/exactly/);
    expect(() => buildClaudeArgv({ ...input, allowedTools: ["Bash"] })).toThrow(/exactly/);
  });

  it("rejects a non-UUID session id and a non-positive turn cap", () => {
    expect(() => buildClaudeArgv({ ...input, sessionId: "abc" })).toThrow(/UUID/);
    expect(() => buildClaudeArgv({ ...input, maxTurns: 0 })).toThrow(/maxTurns/);
  });
});

describe("tool names and mcp config", () => {
  it("round-trips the bridge prefix", () => {
    expect(cliToolName("note_read")).toBe("mcp__obsidian-vault__note_read");
    expect(stripCliToolName("mcp__obsidian-vault__note_read")).toBe("note_read");
    expect(stripCliToolName("Bash")).toBe("Bash");
  });
  it("builds an http server entry with the bearer header", () => {
    expect(JSON.parse(mcpConfigJson(7, "t"))).toEqual({
      mcpServers: { "obsidian-vault": { type: "http", url: "http://127.0.0.1:7/mcp", headers: { Authorization: "Bearer t" } } },
    });
  });
});
