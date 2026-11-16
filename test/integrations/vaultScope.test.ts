import { describe, expect, it } from "vitest";
import {
  DesktopRuntime,
  ExecFailure,
  type DesktopFsPort,
  type ExecFileOptions,
  type ExecFilePort,
  type ExecResult,
} from "../../src/integrations/desktopRuntime";

// Every agent install and registration lands in the open vault: no command
// writes Claude Code's user scope, and no CLI's user config is touched.

class RecordingExec implements ExecFilePort {
  readonly calls: Array<{ executable: string; args: string[]; options: ExecFileOptions }> = [];
  private pluginLists = 0;

  constructor(private readonly vaultPath: string) {}

  async run(executable: string, args: string[], options: ExecFileOptions): Promise<ExecResult> {
    this.calls.push({ executable, args, options });
    const command = [executable, ...args].join(" ");
    if (command === "claude --version") return { stdout: "2.1.323 (Claude Code)\n", stderr: "" };
    if (command === "obsidian version") return { stdout: "1.12.7\n", stderr: "" };
    if (command === "codex --version") return { stdout: "codex-cli 0.166.0\n", stderr: "" };
    if (command === "agy --version") return { stdout: "1.5.3\n", stderr: "" };
    if (command === "claude plugin marketplace list --json") return { stdout: "[]", stderr: "" };
    if (command === "claude plugin list --json") {
      this.pluginLists += 1;
      const installed = this.pluginLists > 1;
      // A user-scope install from elsewhere never counts as this vault's.
      const user = { id: "obsidian-agent@cavi-ai", scope: "user", enabled: true, projectPath: null };
      const vault = { id: "obsidian-agent@cavi-ai", scope: "project", enabled: true, projectPath: this.vaultPath };
      return { stdout: JSON.stringify(installed ? [user, vault] : [user]), stderr: "" };
    }
    if (executable === "claude" && (args[0] === "plugin" || args[0] === "mcp")) return { stdout: "ok\n", stderr: "" };
    throw new ExecFailure(`spawn ${executable} ENOENT`, "ENOENT");
  }
}

class MemoryFs implements DesktopFsPort {
  readonly files = new Map<string, string>();
  async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async backup(): Promise<string | null> { return null; }
  async atomicWrite(path: string, body: string): Promise<void> { this.files.set(path, body); }
  async writeBinary(): Promise<void> {}
}

const HOME = "/Users/test";
const vault = { name: "Field Notes", path: "/Vaults/Field Notes" };
const SCRIPT = `${HOME}/Library/Application Support/Companion for Claude/server/index.js`;
const SHARED = `${HOME}/Library/Application Support/Companion for Claude/bridge.json`;

describe("vault-scoped agent setup", () => {
  it("installs obsidian-agent and registers obsidian-vault in the vault's Claude Code project, never user scope", async () => {
    const exec = new RecordingExec(vault.path);
    const fs = new MemoryFs();
    const runtime = new DesktopRuntime({ exec, fs, platform: "darwin", homeDir: HOME, vault, bridge: { enabled: true, port: 22360, token: "bridge-secret" } });

    const result = await runtime.setupClaudeCode();

    const writes = exec.calls.filter(({ args }) => ["add", "install", "enable"].includes(args[1] === "marketplace" ? args[2] ?? "" : args[1] ?? ""));
    expect(writes.map(({ args }) => args.slice(0, 3).join(" "))).toEqual(["plugin marketplace add", "plugin install obsidian-agent@cavi-ai", "mcp add --scope"]);
    for (const { args, options } of writes) {
      expect(args.join(" ")).toContain("--scope project");
      expect(args).not.toContain("user");
      expect(options.cwd).toBe(vault.path);
    }
    const mcpAdd = writes.at(-1)!.args;
    const connection = mcpAdd.at(-1)!;
    expect(mcpAdd).toEqual(["mcp", "add", "--scope", "project", "obsidian-vault", "--", "node", SCRIPT, connection]);
    expect(connection).not.toBe(SHARED);
    expect(mcpAdd.join(" ")).not.toContain("bridge-secret");
    expect(JSON.parse(fs.files.get(connection)!)).toEqual({ url: "http://127.0.0.1:22360/mcp", token: "bridge-secret", vault: "Field Notes", vaultPath: "/Vaults/Field Notes" });
    expect(fs.files.has(SHARED)).toBe(false);
    expect(result.pluginInstalled && result.pluginEnabled).toBe(true);
  });

  it("writes obsidian-vault into the vault's own Codex and Antigravity config and runs no CLI mcp add", async () => {
    const exec = new RecordingExec(vault.path);
    const fs = new MemoryFs();
    fs.files.set(`${vault.path}/.codex/config.toml`, 'model = "o3"\n');
    fs.files.set(`${vault.path}/.agents/mcp_config.json`, JSON.stringify({ mcpServers: { keep: { command: "keep" } } }));
    const runtime = new DesktopRuntime({ exec, fs, platform: "darwin", homeDir: HOME, vault });

    expect((await runtime.connectCliHost("codex", { port: 22360, token: "tok", vault })).registered).toBe(true);
    expect((await runtime.connectCliHost("agy", { port: 22360, token: "tok", vault })).registered).toBe(true);

    expect(exec.calls.some(({ args }) => args[0] === "mcp")).toBe(false);
    const codex = fs.files.get(`${vault.path}/.codex/config.toml`)!;
    expect(codex.startsWith('model = "o3"\n')).toBe(true);
    expect(codex).toContain(`[mcp_servers.obsidian-vault]\ncommand = "node"\nargs = [${JSON.stringify(SCRIPT)}, `);
    const agy = JSON.parse(fs.files.get(`${vault.path}/.agents/mcp_config.json`)!) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(agy.mcpServers.keep).toEqual({ command: "keep" });
    expect(agy.mcpServers["obsidian-vault"]?.args[0]).toBe(SCRIPT);
    const connection = agy.mcpServers["obsidian-vault"]!.args[1]!;
    expect(codex).toContain(JSON.stringify(connection));
    expect(JSON.parse(fs.files.get(connection)!)).toMatchObject({ token: "tok", vaultPath: vault.path });
    expect(fs.files.has(SHARED)).toBe(false);
    expect((await runtime.inspectCliHosts()).map(({ host, registered }) => [host, registered])).toEqual([["codex", true], ["agy", true]]);
  });
});
