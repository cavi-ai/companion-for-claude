import { describe, it, expect } from "vitest";
import { parseAuthStatus } from "../../src/cli/runtime";
import { claudeExecutableCandidates } from "../../src/integrations/desktopRuntime";

describe("parseAuthStatus", () => {
  it("reads the JSON form", () => {
    expect(parseAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty"\n}')).toEqual({ loggedIn: true, method: "claude.ai" });
  });
  it("treats unparseable output as logged out", () => {
    expect(parseAuthStatus("Not logged in")).toEqual({ loggedIn: false, method: "" });
  });
});

describe("claudeExecutableCandidates", () => {
  it("tries PATH first, then the documented install locations", () => {
    expect(claudeExecutableCandidates("darwin", "/Users/x")).toEqual(["claude", "/Users/x/.local/bin/claude", "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]);
    expect(claudeExecutableCandidates("win32", "C:\\Users\\x")).toEqual(["claude", "C:\\Users\\x\\.local\\bin\\claude.exe"]);
  });
});
