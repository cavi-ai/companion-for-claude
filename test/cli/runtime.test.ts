import { describe, it, expect } from "vitest";
import { parseAuthStatus, parseShellPath, parseVersion, searchDirs, executableCandidates } from "../../src/cli/runtime";
import { codexBackend } from "../../src/cli/backends/codex";
import { claudeBackend } from "../../src/cli/backends/claude";
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

describe("parseShellPath", () => {
  it("reads the PATH between the markers and ignores shell startup noise", () => {
    expect(parseShellPath("motd line\n__CC_PATH__/a/bin:/b/bin:__CC_PATH__\n")).toEqual(["/a/bin", "/b/bin"]);
  });
  it("returns nothing when the markers are missing", () => {
    expect(parseShellPath("zsh: command not found")).toEqual([]);
  });
});

describe("parseVersion", () => {
  it("picks the version token, not the program name", () => {
    expect(parseVersion("codex-cli 0.146.0\n")).toBe("0.146.0");
    expect(parseVersion("2.1.257 (Claude Code)")).toBe("2.1.257");
    expect(parseVersion("1.18.31")).toBe("1.18.31");
  });
  it("falls back to the first token when nothing looks like a version", () => {
    expect(parseVersion("dev\n")).toBe("dev");
  });
});

describe("searchDirs", () => {
  it("orders process PATH, then login-shell PATH, then common install dirs, without duplicates", () => {
    expect(searchDirs("darwin", "/Users/x", ["/opt/homebrew/bin", "/Users/x/.local/bin"], "/usr/bin:/bin")).toEqual([
      "/usr/bin", "/bin", "/opt/homebrew/bin", "/Users/x/.local/bin",
      "/usr/local/bin", "/Users/x/.bun/bin", "/Users/x/.opencode/bin", "/Users/x/.npm-global/bin",
    ]);
  });
});

describe("executableCandidates", () => {
  it("tries the bare name, then the binary in every search dir (GUI apps on macOS get only /usr/bin:/bin:/usr/sbin:/sbin)", () => {
    expect(executableCandidates(codexBackend, "darwin", "/Users/x", ["/a", "/b"])).toEqual(["codex", "/a/codex", "/b/codex"]);
  });
  it("keeps Claude's documented locations first", () => {
    expect(executableCandidates(claudeBackend, "darwin", "/Users/x", ["/a"]).slice(0, 5)).toEqual([
      "claude", "/Users/x/.local/bin/claude", "/usr/local/bin/claude", "/opt/homebrew/bin/claude", "/a/claude",
    ]);
  });
});
