import { describe, expect, it } from "vitest";
import {
  cliHostCandidates,
  cliHostRegisterArgs,
  cliHostRegistered,
  cliHostStatusArgs,
  parseCliVersion,
} from "../../src/integrations/cliHosts";

describe("agent CLI hosts", () => {
  it("looks for each CLI on PATH and in its documented install folders", () => {
    expect(cliHostCandidates("agy", "darwin", "/Users/me")).toEqual(["agy", "/Users/me/.local/bin/agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]);
    expect(cliHostCandidates("codex", "win32", "C:\\Users\\me")).toEqual(["codex"]);
  });

  it("reads the version each CLI prints", () => {
    expect(parseCliVersion("codex-cli 0.162.1\n")).toEqual({ available: true, state: "available", version: "0.162.1" });
    expect(parseCliVersion("1.4.3\n").version).toBe("1.4.3");
    expect(() => parseCliVersion("usage: agy\n")).toThrow("did not report a version");
  });

  it("registers the connector as `node <script>` with each CLI's own mcp add", () => {
    expect(cliHostRegisterArgs("codex", "/c/server/index.js")).toEqual(["mcp", "add", "obsidian-vault", "--", "node", "/c/server/index.js"]);
    expect(cliHostRegisterArgs("agy", "/c/server/index.js")).toEqual(["mcp", "add", "obsidian-vault", "node", "/c/server/index.js"]);
  });

  it("finds obsidian-vault in each CLI's status output", () => {
    expect(cliHostStatusArgs("codex")).toEqual(["mcp", "get", "obsidian-vault"]);
    expect(cliHostRegistered("codex", "obsidian-vault\n  enabled: true\n")).toBe(true);
    expect(cliHostStatusArgs("agy")).toEqual(["mcp", "list"]);
    expect(cliHostRegistered("agy", "NAME            TYPE   STATUS   COMMAND/URL\nobsidian-vault  stdio  enabled  node /c/index.js\n")).toBe(true);
    expect(cliHostRegistered("agy", "NAME  TYPE  STATUS  COMMAND/URL\nobsidian-vault-old  stdio  enabled  node /x\n")).toBe(false);
    expect(cliHostRegistered("agy", "No MCP servers configured.\n")).toBe(false);
  });
});
