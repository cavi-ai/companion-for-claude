import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { strFromU8, unzipSync } from "fflate";
import {
  DesktopRuntime,
  ExecFailure,
  claudeDesktopConfigPath,
  managedProcessPortFromSpawn,
  type DesktopFsPort,
  type ExecFileOptions,
  type ExecFilePort,
  type ExecResult,
} from "../../src/integrations/desktopRuntime";
import { PROXY_SOURCE, vaultConnectionFilePath } from "../../src/integrations/desktopExtension";

class FakeExec implements ExecFilePort {
  readonly calls: Array<{ executable: string; args: string[]; options: ExecFileOptions }> = [];

  constructor(
    private readonly responses: Map<string, ExecResult | Error | ExecResult[]>,
    private readonly onRun?: (executable: string, args: string[], options: ExecFileOptions) => void,
  ) {}

  async run(executable: string, args: string[], options: ExecFileOptions): Promise<ExecResult> {
    this.calls.push({ executable, args, options });
    this.onRun?.(executable, args, options);
    const configured = this.responses.get([executable, ...args].join("\u0000"));
    const response = Array.isArray(configured) ? configured.shift() : configured;
    if (response instanceof Error) throw response;
    // An unconfigured executable is one that is not installed, which is ENOENT.
    if (!response) throw new ExecFailure(`spawn ${executable} ENOENT`, "ENOENT");
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

  readonly binaries = new Map<string, Uint8Array>();

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    this.binaries.set(path, data);
  }
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "" });
const key = (executable: string, ...args: string[]): string => [executable, ...args].join("\u0000");

const VAULT = { name: "Notes", path: "/v/Notes" };
/** obsidian-agent as `claude plugin list --json` reports a project install for VAULT. */
const vaultPlugins = (enabled: boolean, id = "obsidian-agent@cavi-ai"): string => JSON.stringify([{ id, scope: "project", enabled, projectPath: VAULT.path }]);
const VAULT_CONNECTION = vaultConnectionFilePath("darwin", "/Users/test", {}, VAULT);
const SCRIPT = "/Users/test/Library/Application Support/Companion for Claude/server/index.js";
const VAULT_MCP_JSON = "/v/Notes/.mcp.json";
const projectMcp = (connectionPath = VAULT_CONNECTION): string => JSON.stringify({ mcpServers: { "obsidian-vault": { type: "stdio", command: "node", args: [SCRIPT, connectionPath], env: {} } } });
const BRIDGE = { enabled: true, port: 22360, token: "bridge-secret-token" };

const readyResponses = (): Map<string, ExecResult | Error | ExecResult[]> => new Map([
  [key("claude", "--version"), ok("2.1.226 (Claude Code)\n")],
  [key("obsidian", "version"), ok("1.12.7\n")],
  [key("claude", "plugin", "marketplace", "list", "--json"), ok('[{"name":"cavi-ai","repo":"cavi-ai/plugins"}]')],
  [key("claude", "plugin", "list", "--json"), ok(vaultPlugins(true))],
]);

describe("DesktopRuntime", () => {
  it("streams a managed child process and terminates it on abort without retaining listeners", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const on = (name: string, listener: (...args: unknown[]) => void) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); };
    const off = (name: string, listener: (...args: unknown[]) => void) => { listeners.get(name)?.delete(listener); };
    let killed = false;
    const child = {
      stdout: { on: (name: string, listener: (...args: unknown[]) => void) => on(`out:${name}`, listener), off: (name: string, listener: (...args: unknown[]) => void) => off(`out:${name}`, listener) },
      stderr: { on: (name: string, listener: (...args: unknown[]) => void) => on(`err:${name}`, listener), off: (name: string, listener: (...args: unknown[]) => void) => off(`err:${name}`, listener) },
      once: on,
      off,
      kill: () => { killed = true; queueMicrotask(() => { for (const listener of listeners.get("close") ?? []) listener(null, "SIGTERM"); }); return true; },
    };
    const port = managedProcessPortFromSpawn(() => child, { setTimeout, clearTimeout });
    const controller = new AbortController();
    const pending = port.run("claude", ["-p", "safe"], { cwd: "/vault", signal: controller.signal, onStdout: () => {}, onStderr: () => {} });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(killed).toBe(true);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("escalates cancellation to SIGKILL when a child ignores SIGTERM and clears the timer", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const on = (name: string, listener: (...args: unknown[]) => void) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); };
    const off = (name: string, listener: (...args: unknown[]) => void) => { listeners.get(name)?.delete(listener); };
    const signals: string[] = [];
    const child = {
      stdout: { on: (name: string, listener: (...args: unknown[]) => void) => on(`out:${name}`, listener), off: (name: string, listener: (...args: unknown[]) => void) => off(`out:${name}`, listener) },
      stderr: { on: (name: string, listener: (...args: unknown[]) => void) => on(`err:${name}`, listener), off: (name: string, listener: (...args: unknown[]) => void) => off(`err:${name}`, listener) },
      once: on,
      off,
      kill: (signal?: string) => {
        signals.push(signal ?? "");
        if (signal === "SIGKILL") queueMicrotask(() => { for (const listener of listeners.get("close") ?? []) listener(null, signal); });
        return true;
      },
    };
    const port = managedProcessPortFromSpawn(() => child, { setTimeout, clearTimeout });
    const controller = new AbortController();
    const pending = port.run("claude", ["-p", "safe"], { cwd: "/vault", signal: controller.signal, onStdout: () => {}, onStderr: () => {} });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_100);
    await rejection;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    vi.useRealTimers();
  });

  it("streams and exits a real child process through the managed boundary", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const port = managedProcessPortFromSpawn(spawn as never, { setTimeout, clearTimeout });
    const result = await port.run(process.execPath, ["-e", "process.stdout.write('one\\n'); process.stderr.write('warn\\n');"], {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });
    expect(result.code).toBe(0);
    expect(stdout.join("")).toBe("one\n");
    expect(stderr.join("")).toBe("warn\n");
  });

  it("inspects Claude Code and Obsidian through bounded fixed commands, asking Claude Code from the vault folder", async () => {
    const exec = new FakeExec(readyResponses());
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    await expect(runtime.inspectClaudeCode()).resolves.toEqual({
      claude: { available: true, state: "available", version: "2.1.226" },
      obsidian: { available: true, state: "available", version: "1.12.7" },
      marketplaceInstalled: true,
      pluginInstalled: true,
      pluginEnabled: true,
      bridge: { enabled: false, registered: false },
    });
    expect(exec.calls.map(({ executable, args }) => [executable, args])).toEqual([
      ["claude", ["--version"]],
      ["obsidian", ["version"]],
      ["claude", ["plugin", "marketplace", "list", "--json"]],
      ["claude", ["plugin", "list", "--json"]],
    ]);
    expect(exec.calls.every(({ options }) => options.timeoutMs === 5_000 && options.maxBytes === 256_000)).toBe(true);
    expect(exec.calls.slice(2).every(({ options }) => options.cwd === VAULT.path)).toBe(true);
  });

  it("does not count a user-scope obsidian-agent or another vault's install as this vault's", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "list", "--json"), ok(JSON.stringify([
      { id: "obsidian-agent@cavi-ai", scope: "user", enabled: true, projectPath: null },
      { id: "obsidian-agent@cavi-ai", scope: "project", enabled: true, projectPath: "/v/Other" },
    ])));
    const runtime = new DesktopRuntime({ exec: new FakeExec(responses), fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({ pluginInstalled: false, pluginEnabled: false });
  });

  it("reads the bridge registration from the vault's .mcp.json, and only this vault's connector counts", async () => {
    const fs = new MemoryFs();
    const runtime = new DesktopRuntime({ exec: new FakeExec(readyResponses()), fs, platform: "darwin", homeDir: "/Users/test", bridge: BRIDGE, vault: VAULT });

    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({ bridge: { enabled: true, registered: false } });
    fs.files.set(VAULT_MCP_JSON, projectMcp("/elsewhere/bridge.json"));
    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({ bridge: { enabled: true, registered: false } });
    fs.files.set(VAULT_MCP_JSON, projectMcp());
    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({ bridge: { enabled: true, registered: true } });
  });

  it("runs no mcp command while inspecting", async () => {
    const exec = new FakeExec(readyResponses());
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", bridge: BRIDGE, vault: VAULT });

    await runtime.inspectClaudeCode();
    expect(exec.calls.some(({ args }) => args[0] === "mcp")).toBe(false);
  });

  it("ignores a same-prefix local marketplace and a plugin from another marketplace", async () => {
    const responses = readyResponses();
    // A local directory marketplace named `cavi` is not the published catalog:
    // counting it skips `marketplace add`, and the install that follows fails.
    responses.set(key("claude", "plugin", "marketplace", "list", "--json"), ok('[{"name":"cavi"},{"name":"claude-plugins-official","repo":"anthropics/claude-plugins-official"}]'));
    responses.set(key("claude", "plugin", "list", "--json"), ok(vaultPlugins(true, "obsidian-agent@cavi")));
    const runtime = new DesktopRuntime({ exec: new FakeExec(responses), fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({
      marketplaceInstalled: false,
      pluginInstalled: false,
      pluginEnabled: false,
    });
  });

  it("re-adds the catalog when it is registered under a pre-rename name", async () => {
    // Anyone who added cavi-ai/plugins before the rename has it as `plugins`.
    // `plugin install <id>@cavi-ai` resolves by name, so the repo matching is
    // not enough — the marketplace still has to be added under its new name.
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "marketplace", "list", "--json"), ok('[{"name":"plugins","repo":"cavi-ai/plugins"}]'));
    responses.set(key("claude", "plugin", "list", "--json"), ok("[]"));
    const runtime = new DesktopRuntime({ exec: new FakeExec(responses), fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({ marketplaceInstalled: false });
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
    responses.set(key("/Users/test/.local/bin/claude", "plugin", "list", "--json"), ok(vaultPlugins(true)));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    await expect(runtime.inspectClaudeCode()).resolves.toMatchObject({
      claude: { available: true },
      obsidian: { available: true },
      pluginEnabled: true,
    });
    expect(exec.calls.map(({ executable }) => executable)).toContain("/Users/test/.local/bin/claude");
    expect(exec.calls.map(({ executable }) => executable)).toContain("/usr/local/bin/obsidian");
  });

  it("enables an installed but disabled obsidian-agent in the vault before reporting ready", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "list", "--json"), [ok(vaultPlugins(false)), ok(vaultPlugins(true))]);
    responses.set(key("claude", "plugin", "enable", "obsidian-agent@cavi-ai", "--scope", "project"), ok("enabled"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    const result = await runtime.setupClaudeCode();
    const enable = exec.calls.find(({ args }) => args.join(" ") === "plugin enable obsidian-agent@cavi-ai --scope project");
    expect(enable?.options.cwd).toBe(VAULT.path);
    expect(result.pluginEnabled).toBe(true);
  });

  it("executes missing setup stages in order in the vault and re-inspects the result", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "marketplace", "list", "--json"), [ok("[]"), ok('[{"name":"cavi-ai","repo":"cavi-ai/plugins"}]')]);
    responses.set(key("claude", "plugin", "list", "--json"), [ok("[]"), ok(vaultPlugins(true))]);
    responses.set(key("claude", "plugin", "marketplace", "add", "cavi-ai/plugins", "--scope", "project"), ok("added"));
    responses.set(key("claude", "plugin", "install", "obsidian-agent@cavi-ai", "--scope", "project"), ok("installed"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    const result = await runtime.setupClaudeCode();
    expect(exec.calls.slice(4, 6).map(({ executable, args, options }) => [executable, args, options.cwd])).toEqual([
      ["claude", ["plugin", "marketplace", "add", "cavi-ai/plugins", "--scope", "project"], VAULT.path],
      ["claude", ["plugin", "install", "obsidian-agent@cavi-ai", "--scope", "project"], VAULT.path],
    ]);
    expect(result.claude.available).toBe(true);
  });

  it("refuses setup without a vault folder and runs nothing", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "list", "--json"), ok("[]"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });

    await expect(runtime.setupClaudeCode()).rejects.toThrow("no folder on disk");
    expect(exec.calls.some(({ args }) => ["add", "install", "enable"].includes(args[1] ?? "") || args[2] === "add")).toBe(false);
  });

  it("stops setup after the first failed stage and redacts its error", async () => {
    const responses = readyResponses();
    responses.set(key("claude", "plugin", "marketplace", "list", "--json"), ok("[]"));
    responses.set(key("claude", "plugin", "list", "--json"), ok("[]"));
    responses.set(key("claude", "plugin", "marketplace", "add", "cavi-ai/plugins", "--scope", "project"), new Error("Authorization: Bearer private-token"));
    const exec = new FakeExec(responses);
    const runtime = new DesktopRuntime({ exec, fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", vault: VAULT });

    await expect(runtime.setupClaudeCode()).rejects.toThrow("Add the CAVI marketplace");
    expect(exec.calls.some(({ args }) => args.includes("obsidian-agent@cavi-ai"))).toBe(false);
  });

  const MCP_ADD = ["mcp", "add", "--scope", "project", "obsidian-vault", "--", "node", SCRIPT, VAULT_CONNECTION];

  it("connects Companion's vault tools during setup and redacts the token on failure", async () => {
    const responses = readyResponses();
    responses.set(key("claude", ...MCP_ADD), new Error("Command failed: token bridge-secret-token rejected"));
    const runtime = new DesktopRuntime({ exec: new FakeExec(responses), fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test", bridge: BRIDGE, vault: VAULT });

    const failure = await runtime.setupClaudeCode().catch((cause: Error) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Connect Companion's vault tools");
    expect((failure as Error).message).not.toContain("bridge-secret-token");
  });

  it("registers Companion's vault tools in the vault's .mcp.json through this vault's connection file", async () => {
    const responses = readyResponses();
    responses.set(key("claude", ...MCP_ADD), ok("added"));
    const fs = new MemoryFs();
    // Claude Code writes the project entry into the vault's .mcp.json.
    const exec = new FakeExec(responses, (_executable, args) => { if (args[0] === "mcp" && args[1] === "add") fs.files.set(VAULT_MCP_JSON, projectMcp()); });
    const runtime = new DesktopRuntime({ exec, fs, platform: "darwin", homeDir: "/Users/test", bridge: BRIDGE, vault: VAULT });

    const result = await runtime.setupClaudeCode();
    expect(result.bridge.registered).toBe(true);
    const add = exec.calls.find(({ args }) => args[0] === "mcp");
    expect(add?.args).toEqual(MCP_ADD);
    expect(add?.options.cwd).toBe(VAULT.path);
    expect(add?.args.join(" ")).not.toContain(BRIDGE.token);
    expect(JSON.parse(fs.files.get(VAULT_CONNECTION)!)).toEqual({ url: "http://127.0.0.1:22360/mcp", token: BRIDGE.token, vault: "Notes", vaultPath: "/v/Notes" });
    expect(fs.files.get(SCRIPT)).toBe(PROXY_SOURCE);
  });

  const DESKTOP_CONFIG = "/Users/test/Library/Application Support/Claude/claude_desktop_config.json";
  const LEGACY_ENTRY = { command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:22360/mcp", "--header", "Authorization: Bearer old-token"] };
  const desktopRuntime = (fs: MemoryFs, openPath: (path: string) => Promise<void>) =>
    new DesktopRuntime({ exec: new FakeExec(new Map()), fs, platform: "darwin", homeDir: "/Users/test", tempDir: "/tmp/companion/", openPath });

  const CONNECTION_FILE = "/Users/test/Library/Application Support/Companion for Claude/bridge.json";
  const CONNECTOR_SCRIPT = "/Users/test/Library/Application Support/Companion for Claude/server/index.js";

  it("writes the connection file and the bundle, opens it, and removes the mcp-remote entry earlier versions wrote", async () => {
    const fs = new MemoryFs();
    fs.files.set(DESKTOP_CONFIG, JSON.stringify({ theme: "dark", mcpServers: { keep: { command: "keep" }, "obsidian-vault": LEGACY_ENTRY } }));
    const opened: string[] = [];
    const result = await desktopRuntime(fs, async (path) => { opened.push(path); }).installClaudeDesktop({ port: 22360, token: "bridge-token" });

    const bundlePath = "/tmp/companion/companion-obsidian-vault.mcpb";
    expect(result).toEqual({ bundlePath, connectionPath: CONNECTION_FILE, configPath: DESKTOP_CONFIG, backupPath: `${DESKTOP_CONFIG}.backup`, legacyRemoved: true });
    expect(opened).toEqual([bundlePath]);
    expect(JSON.parse(fs.files.get(CONNECTION_FILE)!)).toEqual({ url: "http://127.0.0.1:22360/mcp", token: "bridge-token" });
    expect(JSON.parse(fs.files.get(DESKTOP_CONFIG)!)).toEqual({ theme: "dark", mcpServers: { keep: { command: "keep" } } });
    const files = unzipSync(fs.binaries.get(bundlePath)!);
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "server/index.js"]);
    expect(Object.values(files).map((data) => strFromU8(data)).join("\n")).not.toContain("bridge-token");
  });

  it("leaves Claude Desktop's config alone when it holds no entry Companion wrote", async () => {
    for (const original of [null, "{", JSON.stringify({ mcpServers: { keep: { command: "keep" } } })]) {
      const fs = new MemoryFs();
      if (original !== null) fs.files.set(DESKTOP_CONFIG, original);
      const result = await desktopRuntime(fs, async () => undefined).installClaudeDesktop({ port: 22360, token: "secret" });
      expect(result.legacyRemoved).toBe(false);
      expect(fs.backups).toEqual([]);
      expect(fs.writes.map((write) => write.path)).toEqual([CONNECTION_FILE]);
    }
  });

  it("keeps the old entry and says where the bundle is when Claude Desktop cannot open it", async () => {
    const fs = new MemoryFs();
    const original = JSON.stringify({ mcpServers: { "obsidian-vault": LEGACY_ENTRY } });
    fs.files.set(DESKTOP_CONFIG, original);
    const install = desktopRuntime(fs, async () => { throw new Error("No application knows how to open the file"); })
      .installClaudeDesktop({ port: 22360, token: "secret" });
    await expect(install).rejects.toThrow("Open /tmp/companion/companion-obsidian-vault.mcpb with Claude Desktop.");
    expect(fs.files.get(DESKTOP_CONFIG)).toBe(original);
    expect(fs.writes.map((write) => write.path)).toEqual([CONNECTION_FILE]);
  });

  it("names the vault in the connection file so the extension can open it", async () => {
    const fs = new MemoryFs();
    await desktopRuntime(fs, async () => undefined).installClaudeDesktop({ port: 22360, token: "t", vault: { name: "Notes", path: "/v/Notes" } });
    expect(JSON.parse(fs.files.get(CONNECTION_FILE)!)).toEqual({ url: "http://127.0.0.1:22360/mcp", token: "t", vault: "Notes", vaultPath: "/v/Notes" });
  });

  it("moves this vault's connection file to the bridge's new port and token and leaves any other alone", async () => {
    const vault = { name: "Notes", path: "/v/Notes" };
    const fs = new MemoryFs();
    fs.files.set(CONNECTION_FILE, JSON.stringify({ url: "http://127.0.0.1:22360/mcp", token: "old", vault: "Notes", vaultPath: "/v/Notes" }));
    const runtime = desktopRuntime(fs, async () => undefined);
    expect(await runtime.refreshConnection({ port: 22361, token: "new", vault })).toBe(true);
    expect(JSON.parse(fs.files.get(CONNECTION_FILE)!)).toEqual({ url: "http://127.0.0.1:22361/mcp", token: "new", vault: "Notes", vaultPath: "/v/Notes" });
    expect(await runtime.refreshConnection({ port: 22361, token: "new", vault })).toBe(false);
    expect(await runtime.refreshConnection({ port: 1, token: "other", vault: { name: "Other", path: "/v/Other" } })).toBe(false);
    expect(fs.writes).toHaveLength(1);
    const unclaimed = new MemoryFs();
    unclaimed.files.set(CONNECTION_FILE, JSON.stringify({ url: "http://127.0.0.1:22360/mcp", token: "old" }));
    expect(await desktopRuntime(unclaimed, async () => undefined).refreshConnection({ port: 1, token: "new", vault })).toBe(false);
    expect(await desktopRuntime(new MemoryFs(), async () => undefined).refreshConnection({ port: 1, token: "new", vault })).toBe(false);
  });

  it("replaces a connector script an earlier version wrote, and writes none that was never installed", async () => {
    const vault = { name: "Notes", path: "/v/Notes" };
    const connection = JSON.stringify({ url: "http://127.0.0.1:22360/mcp", token: "tok", vault: "Notes", vaultPath: "/v/Notes" });
    const fs = new MemoryFs();
    fs.files.set(CONNECTION_FILE, connection);
    fs.files.set(CONNECTOR_SCRIPT, "// an earlier connector");
    expect(await desktopRuntime(fs, async () => undefined).refreshConnection({ port: 22360, token: "tok", vault })).toBe(true);
    expect(fs.files.get(CONNECTOR_SCRIPT)).toBe(PROXY_SOURCE);
    const fresh = new MemoryFs();
    fresh.files.set(CONNECTION_FILE, connection);
    expect(await desktopRuntime(fresh, async () => undefined).refreshConnection({ port: 22360, token: "tok", vault })).toBe(false);
    expect(fresh.files.has(CONNECTOR_SCRIPT)).toBe(false);
  });

  it("keeps this vault's own connection file on the bridge's new port and token too", async () => {
    const fs = new MemoryFs();
    fs.files.set(VAULT_CONNECTION, JSON.stringify({ url: "http://127.0.0.1:22360/mcp", token: "old", vault: "Notes", vaultPath: "/v/Notes" }));
    const runtime = desktopRuntime(fs, async () => undefined);
    expect(await runtime.refreshConnection({ port: 22361, token: "new", vault: VAULT })).toBe(true);
    expect(JSON.parse(fs.files.get(VAULT_CONNECTION)!)).toEqual({ url: "http://127.0.0.1:22361/mcp", token: "new", vault: "Notes", vaultPath: "/v/Notes" });
    expect(fs.files.has(CONNECTION_FILE)).toBe(false);
  });

  describe("agent CLIs", () => {
    const vault = VAULT;
    const CODEX_CONFIG = "/v/Notes/.codex/config.toml";
    const AGY_CONFIG = "/v/Notes/.agents/mcp_config.json";
    const installed = () => new Map<string, ExecResult | Error | ExecResult[]>([
      [key("codex", "--version"), ok("codex-cli 0.162.1\n")],
      [key("agy", "--version"), ok("1.4.3\n")],
    ]);
    const hostRuntime = (exec: FakeExec, fs = new MemoryFs()) => new DesktopRuntime({ exec, fs, platform: "darwin", homeDir: "/Users/test", vault });

    it("reports each CLI's version and whether this vault's config registers obsidian-vault", async () => {
      const fs = new MemoryFs();
      fs.files.set(CODEX_CONFIG, `[mcp_servers.obsidian-vault]\ncommand = "node"\nargs = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(VAULT_CONNECTION)}]\n`);
      expect(await hostRuntime(new FakeExec(installed()), fs).inspectCliHosts()).toEqual([
        { host: "codex", probe: { available: true, state: "available", version: "0.162.1" }, registered: true },
        { host: "agy", probe: { available: true, state: "available", version: "1.4.3" }, registered: false },
      ]);
      expect((await hostRuntime(new FakeExec(new Map())).inspectCliHosts()).map(({ host, probe, registered }) => [host, probe.state, registered]))
        .toEqual([["codex", "missing", false], ["agy", "missing", false]]);
    });

    it("writes this vault's connection file, the connector, and obsidian-vault in the vault's Antigravity config", async () => {
      const exec = new FakeExec(installed());
      const fs = new MemoryFs();
      const result = await hostRuntime(exec, fs).connectCliHost("agy", { port: 22360, token: "bridge-token", vault });
      expect(result).toEqual({ host: "agy", probe: { available: true, state: "available", version: "1.4.3" }, registered: true });
      expect(JSON.parse(fs.files.get(VAULT_CONNECTION)!)).toEqual({ url: "http://127.0.0.1:22360/mcp", token: "bridge-token", vault: "Notes", vaultPath: "/v/Notes" });
      expect(fs.files.get(CONNECTOR_SCRIPT)).toBe(PROXY_SOURCE);
      expect(JSON.parse(fs.files.get(AGY_CONFIG)!)).toEqual({ mcpServers: { "obsidian-vault": { command: "node", args: [SCRIPT, VAULT_CONNECTION] } } });
      expect(fs.files.get(AGY_CONFIG)).not.toContain("bridge-token");
      expect(fs.files.has(CONNECTION_FILE)).toBe(false);
      expect(exec.calls.map(({ args }) => args.join(" "))).toEqual(["--version", "--version"]);
    });

    it("writes obsidian-vault into the vault's .codex/config.toml", async () => {
      const fs = new MemoryFs();
      const result = await hostRuntime(new FakeExec(installed()), fs).connectCliHost("codex", { port: 22360, token: "t", vault });
      expect(result.registered).toBe(true);
      expect(fs.files.get(CODEX_CONFIG)).toBe(`[mcp_servers.obsidian-vault]\ncommand = "node"\nargs = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(VAULT_CONNECTION)}]\n`);
    });

    it("says what to install when the CLI is missing, and leaves a config it cannot read untouched", async () => {
      await expect(hostRuntime(new FakeExec(new Map())).connectCliHost("codex", { port: 1, token: "t", vault })).rejects.toThrow("Codex was not found");
      const fs = new MemoryFs();
      fs.files.set(AGY_CONFIG, "{ broken");
      await expect(hostRuntime(new FakeExec(installed()), fs).connectCliHost("agy", { port: 1, token: "t", vault })).rejects.toThrow("is not valid JSON");
      expect(fs.files.get(AGY_CONFIG)).toBe("{ broken");
      expect(fs.files.has(VAULT_CONNECTION)).toBe(false);
    });
  });

  it("refuses an empty token and a device that cannot open the bundle", async () => {
    await expect(desktopRuntime(new MemoryFs(), async () => undefined).installClaudeDesktop({ port: 1, token: " " })).rejects.toThrow("token is empty");
    const noOpener = new DesktopRuntime({ exec: new FakeExec(new Map()), fs: new MemoryFs(), platform: "darwin", homeDir: "/Users/test" });
    await expect(noOpener.installClaudeDesktop({ port: 1, token: "t" })).rejects.toThrow("cannot write or open");
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

// The Obsidian CLI answers only while it can reach the running app; a shim that
// exists and exits non-zero is a different problem from one that is not there,
// and reporting the first as "not found" sends the user after the wrong fix.
describe("CLI probe states", () => {
  const ranAndFailed = (message: string): ExecFailure => new ExecFailure(message);
  const notInstalled = (): ExecFailure => new ExecFailure("spawn ENOENT", "ENOENT");

  const withObsidian = (response: ExecResult | Error): Map<string, ExecResult | Error | ExecResult[]> => {
    const responses = readyResponses();
    responses.set(key("obsidian", "version"), response);
    return responses;
  };

  it("reports an installed but unresponsive CLI as unreachable, not missing", async () => {
    const runtime = new DesktopRuntime({
      exec: new FakeExec(withObsidian(ranAndFailed("Command failed: obsidian version\nThe CLI is unable to find Obsidian."))),
      fs: new MemoryFs(),
      platform: "darwin",
      homeDir: "/Users/test",
    });
    const { obsidian } = await runtime.inspectClaudeCode();
    expect(obsidian.available).toBe(false);
    expect(obsidian.state).toBe("unreachable");
    expect(obsidian.message).toContain("unable to find Obsidian");
  });

  it("reports a CLI that is nowhere on disk as missing", async () => {
    const runtime = new DesktopRuntime({
      exec: new FakeExec(withObsidian(notInstalled())),
      fs: new MemoryFs(),
      platform: "darwin",
      homeDir: "/Users/test",
    });
    const { obsidian } = await runtime.inspectClaudeCode();
    expect(obsidian.state).toBe("missing");
  });

  // A later absent candidate must not overwrite an earlier one that actually ran.
  it("keeps the failure from the candidate that ran", async () => {
    const responses = withObsidian(ranAndFailed("unable to find Obsidian"));
    const runtime = new DesktopRuntime({
      exec: new FakeExec(responses),
      fs: new MemoryFs(),
      platform: "darwin",
      homeDir: "/Users/test",
    });
    const { obsidian } = await runtime.inspectClaudeCode();
    expect(obsidian.state).toBe("unreachable");
    expect(obsidian.executable).toBe("obsidian");
  });

  it("finds the CLI at Obsidian's documented Linux target when PATH misses it", async () => {
    const responses = readyResponses();
    responses.delete(key("obsidian", "version"));
    responses.set(key("/home/me/.local/bin/obsidian", "version"), ok("1.12.7\n"));
    const runtime = new DesktopRuntime({
      exec: new FakeExec(responses),
      fs: new MemoryFs(),
      platform: "linux",
      homeDir: "/home/me",
    });
    const { obsidian } = await runtime.inspectClaudeCode();
    expect(obsidian).toMatchObject({ available: true, version: "1.12.7" });
  });

  it("falls back to the CLI binary shipped beside the app executable", async () => {
    const responses = readyResponses();
    responses.delete(key("obsidian", "version"));
    responses.set(key("/Applications/Obsidian.app/Contents/MacOS/obsidian-cli", "version"), ok("1.12.7\n"));
    const runtime = new DesktopRuntime({
      exec: new FakeExec(responses),
      fs: new MemoryFs(),
      platform: "darwin",
      homeDir: "/Users/test",
      execDir: "/Applications/Obsidian.app/Contents/MacOS",
    });
    const { obsidian } = await runtime.inspectClaudeCode();
    expect(obsidian).toMatchObject({ available: true, version: "1.12.7" });
  });

  it("refuses to set up Claude Code with the reachability remedy, not a reinstall", async () => {
    const runtime = new DesktopRuntime({
      exec: new FakeExec(withObsidian(ranAndFailed("The CLI is unable to find Obsidian."))),
      fs: new MemoryFs(),
      platform: "darwin",
      homeDir: "/Users/test",
    });
    await expect(runtime.setupClaudeCode()).rejects.toThrow("Restart Obsidian");
  });
});
