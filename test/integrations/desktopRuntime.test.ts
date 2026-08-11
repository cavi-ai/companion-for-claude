import { describe, expect, it } from "vitest";
import {
  DesktopRuntime,
  claudeDesktopConfigPath,
  type DesktopFsPort,
  type ExecFileOptions,
  type ExecFilePort,
  type ExecResult,
} from "../../src/integrations/desktopRuntime";

class FakeExec implements ExecFilePort {
  readonly calls: Array<{ executable: string; args: string[]; options: ExecFileOptions }> = [];

  constructor(private readonly responses: Map<string, ExecResult | Error | ExecResult[]>) {}

  async run(executable: string, args: string[], options: ExecFileOptions): Promise<ExecResult> {
    this.calls.push({ executable, args, options });
    const configured = this.responses.get([executable, ...args].join("\u0000"));
    const response = Array.isArray(configured) ? configured.shift() : configured;
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
    return response;
  }
}

class MemoryFs implements DesktopFsPort {
  readonly files = new Map<string, string>();
  readonly backups: string[] = [];
  readonly writes: Array<{ path: string; body: string }> = [];
  failWrite = false;

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async backup(path: string): Promise<string | null> {
    const body = this.files.get(path);
    if (body === undefined) return null;
    const backup = `${path}.backup`;
    this.files.set(backup, body);
    this.backups.push(backup);
    return backup;
  }

  async atomicWrite(path: string, body: string): Promise<void> {
    this.writes.push({ path, body });
    if (this.failWrite) throw new Error("disk full");
    this.files.set(path, body);
  }
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "" });
const key = (executable: string, ...args: string[]): string => [executable, ...args].join("\u0000");

const readyResponses = (): Map<string, ExecResult | Error | ExecResult[]> => new Map([
  [key("claude", "--version"), ok("2.1.226 (Claude Code)\n")],
  [key("obsidian", "version"), ok("1.12.7\n")],
  [key("claude", "plugin", "marketplace", "list", "--json"), ok('[{"name":"plugins","repo":"cavi-ai/plugins"}]')],
  [key("claude", "plugin", "list", "--json"), ok('[{"id":"obsidian-agent@cavi","enabled":true}]')],
]);

describe("DesktopRuntime", () => {
  it("inspects Claude Code and Obsidian through bounded fixed commands", async () => {
    const exec = new FakeExec(readyResponses());
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.inspectClaudeCode()).resolves.toEqual({
      claude: { available: true, version: "2.1.226" },
      obsidian: { available: true, version: "1.12.7" },
      marketplaceInstalled: true,
      pluginInstalled: true,
      pluginEnabled: true,
    });
    expect(exec.calls.map(({ executable, args }) => [executable, args])).toEqual([
      ["claude", ["--version"]],
      ["obsidian", ["version"]],
      ["claude", ["plugin", "marketplace", "list", "--json"]],
      ["claude", ["plugin", "list", "--json"]],
    ]);
    expect(exec.calls.every(({ options }) => options.timeoutMs === 5_000 && options.maxBytes === 256_000)).toBe(true);
  });

  it("keeps Companion usable when Claude Code is absent and skips plugin probes", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "--version"), new Error("ENOENT"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    const state = await runtime.inspectClaudeCode();
    expect(state.claude.available).toBe(false);
    expect(state.obsidian.available).toBe(true);
    expect(state.marketplaceInstalled).toBe(false);
    expect(state.pluginInstalled).toBe(false);
    expect(state.pluginEnabled).toBe(false);
    expect(exec.calls.some(({ args }) => args.includes("--json"))).toBe(false);
  });

  it("finds fixed native CLI locations when a GUI launch has a thin PATH", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "--version"), new Error("ENOENT"));
    responses.set(key("/Users/test/.local/bin/claude", "--version"), ok("2.1.226 (Claude Code)\n"));
    responses.set(key("obsidian", "version"), new Error("ENOENT"));
    responses.set(key("/usr/local/bin/obsidian", "version"), ok("1.12.7\n"));
    responses.set(key("/Users/test/.local/bin/claude", "plugin", "marketplace", "list", "--json"), ok('[{"name":"cavi","repo":"cavi-ai/plugins"}]'));
    responses.set(key("/Users/test/.local/bin/claude", "plugin", "list", "--json"), ok('[{"id":"obsidian-agent@cavi","enabled":true}]'));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({
      claude: { available: true },
      obsidian: { available: true },
      pluginEnabled: true,
    });
    expect(exec.calls.map(({ executable }) => executable)).toContain("/Users/test/.local/bin/claude");
    expect(exec.calls.map(({ executable }) => executable)).toContain("/usr/local/bin/obsidian");
  });

  it("enables an installed but disabled obsidian-agent before reporting ready", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "list", "--json"), [
      ok('[{"id":"obsidian-agent@cavi","enabled":false}]'),
      ok('[{"id":"obsidian-agent@cavi","enabled":true}]'),
    ]);
    responses.set(key("claude", "plugin", "enable", "obsidian-agent@cavi", "--scope", "user"), ok("enabled"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    const result = await runtime.setupClaudeCode();
    expect(exec.calls.some(({ args }) => args.join(" ") === "plugin enable obsidian-agent@cavi --scope user")).toBe(true);
    expect(result.pluginEnabled).toBe(true);
  });

  it("executes missing setup stages in order and re-inspects the result", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "marketplace", "list", "--json"), [ok("[]"), ok('[{"name":"plugins","repo":"cavi-ai/plugins"}]')]);
    responses.set(key("claude", "plugin", "list", "--json"), [ok("[]"), ok('[{"id":"obsidian-agent@cavi","enabled":true}]')]);
    responses.set(key("claude", "plugin", "marketplace", "add", "cavi-ai/plugins"), ok("added"));
    responses.set(key("claude", "plugin", "install", "obsidian-agent@cavi", "--scope", "user"), ok("installed"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    const result = await runtime.setupClaudeCode();
    expect(exec.calls.slice(4, 6).map(({ executable, args }) => [executable, args])).toEqual([
      ["claude", ["plugin", "marketplace", "add", "cavi-ai/plugins"]],
      ["claude", ["plugin", "install", "obsidian-agent@cavi", "--scope", "user"]],
    ]);
    expect(result.claude.available).toBe(true);
  });

  it("stops setup after the first failed stage and redacts its error", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "marketplace", "list", "--json"), ok("[]"));
    responses.set(key("claude", "plugin", "list", "--json"), ok("[]"));
    responses.set(key("claude", "plugin", "marketplace", "add", "cavi-ai/plugins"), new Error("Authorization: Bearer private-token"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.setupClaudeCode()).rejects.toThrow("Add the CAVI marketplace");
    expect(exec.calls.some(({ args }) => args.includes("obsidian-agent@cavi"))).toBe(false);
  });

  it("backs up and atomically merges Claude Desktop configuration", async () => {
    const fs = new MemoryFs();
    const path = "/Users/test/Library/Application Support/Claude/claude_desktop_config.json";
    fs.files.set(path, '{"theme":"dark","mcpServers":{"keep":{"command":"keep"}}}\n');
    const runtime = new DesktopRuntime({ exec: new FakeExec(new Map()), fs, platform: "darwin", homeDir: "/Users/test" });

    const result = await runtime.installClaudeDesktop({ port: 22360, token: "bridge-token" });
    expect(result).toEqual({ configPath: path, backupPath: `${path}.backup`, restartRequired: true });
    expect(fs.backups).toEqual([`${path}.backup`]);
    const written = JSON.parse(fs.files.get(path)!);
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.keep).toEqual({ command: "keep" });
    expect(written.mcpServers["obsidian-vault"].args).toContain("Authorization: Bearer bridge-token");
  });

  it("does not back up or write malformed Claude Desktop configuration", async () => {
    const fs = new MemoryFs();
    const path = "/Users/test/Library/Application Support/Claude/claude_desktop_config.json";
    fs.files.set(path, "{");
    const runtime = new DesktopRuntime({ exec: new FakeExec(new Map()), fs, platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.installClaudeDesktop({ port: 22360, token: "secret" })).rejects.toThrow("malformed JSON");
    expect(fs.backups).toEqual([]);
    expect(fs.writes).toEqual([]);
    expect(fs.files.get(path)).toBe("{");
  });

  it("leaves the original config available when atomic replacement fails", async () => {
    const fs = new MemoryFs();
    const path = "/Users/test/Library/Application Support/Claude/claude_desktop_config.json";
    const original = '{"mcpServers":{}}\n';
    fs.files.set(path, original);
    fs.failWrite = true;
    const runtime = new DesktopRuntime({ exec: new FakeExec(new Map()), fs, platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.installClaudeDesktop({ port: 22360, token: "secret" })).rejects.toThrow("disk full");
    expect(fs.files.get(path)).toBe(original);
    expect(fs.files.get(`${path}.backup`)).toBe(original);
  });

  it("uses platform-specific Claude Desktop config paths", () => {
    expect(claudeDesktopConfigPath("darwin", "/Users/me", {})).toBe("/Users/me/Library/Application Support/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("win32", "C:\\Users\\me", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }))
      .toBe("C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(() => claudeDesktopConfigPath("linux", "/home/me", {})).toThrow("not supported");
  });

  it("opens macOS Terminal at the vault using arguments rather than a shell command", async () => {
    const responses = new Map<string, ExecResult | Error | ExecResult[]>([
      [key("/usr/bin/open", "-a", "Terminal", "/Vaults/My Notes"), ok("")],
    ]);
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });
    await expect(runtime.openTerminalAtVault("/Vaults/My Notes")).resolves.toEqual({ opened: true });
    expect(exec.calls[0]?.options.cwd).toBe("/Vaults/My Notes");
  });

  it("returns a copyable fallback when no supported terminal launcher opens", async () => {
    const exec = new FakeExec(new Map([
      [key("x-terminal-emulator", "--working-directory", "/home/me/My Notes"), new Error("ENOENT")],
      [key("gnome-terminal", "--working-directory=/home/me/My Notes"), new Error("ENOENT")],
    ]));
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "linux", homeDir: "/home/me" });
    const result = await runtime.openTerminalAtVault("/home/me/My Notes");
    expect(result.opened).toBe(false);
    expect(result.instruction).toBe("cd '/home/me/My Notes' && claude");
  });
});
