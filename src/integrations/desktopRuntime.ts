import {
  DesktopIntegrationError,
  claudeDesktopConfigPath,
  claudeCodeSetupPlan,
  mergeClaudeDesktopConfig,
  parseClaudeVersion,
  parseMarketplaceList,
  parsePluginList,
  sanitizeDesktopError,
  type ClaudeCodeInspection,
  type DesktopPlatform,
  type ProbeResult,
} from "./desktop";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecFileOptions {
  timeoutMs: number;
  maxBytes: number;
  cwd?: string;
}

export interface ExecFilePort {
  run(executable: string, args: string[], options: ExecFileOptions): Promise<ExecResult>;
}

export interface DesktopFsPort {
  read(path: string): Promise<string | null>;
  backup(path: string): Promise<string | null>;
  atomicWrite(path: string, body: string): Promise<void>;
}

export interface DesktopRuntimeOptions {
  exec: ExecFilePort;
  fs: DesktopFsPort;
  platform: DesktopPlatform;
  homeDir: string;
  env?: Record<string, string | undefined>;
}

export interface ClaudeDesktopInstallInput {
  port: number;
  token: string;
  configPath?: string;
}

export interface ClaudeDesktopInstallResult {
  configPath: string;
  backupPath: string | null;
  restartRequired: true;
}

export interface TerminalLaunchResult {
  opened: boolean;
  instruction?: string;
}

const COMMAND_OPTIONS: ExecFileOptions = { timeoutMs: 5_000, maxBytes: 256_000 };

const commandError = (stage: string, cause: unknown, secrets: string[] = []): DesktopIntegrationError => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return new DesktopIntegrationError(stage, `${stage}: ${sanitizeDesktopError(raw, secrets) || "command failed"}`);
};

const parseLooseVersion = (stdout: string): ProbeResult => {
  const version = stdout.trim().split(/\s+/, 1)[0];
  if (!version) throw new Error("no version reported");
  return { available: true, version };
};

export { claudeDesktopConfigPath } from "./desktop";

export class DesktopRuntime {
  private claudeExecutable = "claude";

  constructor(private readonly options: DesktopRuntimeOptions) {}

  private async probe(
    executables: string[],
    args: string[],
    parser: (stdout: string) => ProbeResult,
  ): Promise<{ result: ProbeResult; executable?: string }> {
    let message = "Command not found.";
    for (const executable of [...new Set(executables)]) {
      try {
        const command = await this.options.exec.run(executable, args, COMMAND_OPTIONS);
        return { result: parser(command.stdout), executable };
      } catch (cause) {
        message = sanitizeDesktopError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    return { result: { available: false, message } };
  }

  private claudeCandidates(): string[] {
    if (this.options.platform === "win32") return ["claude", `${this.options.homeDir}\\.local\\bin\\claude.exe`];
    return [
      "claude",
      `${this.options.homeDir}/.local/bin/claude`,
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ];
  }

  private obsidianCandidates(): string[] {
    if (this.options.platform === "win32") return ["obsidian"];
    return ["obsidian", "/usr/local/bin/obsidian", "/opt/homebrew/bin/obsidian", "/usr/bin/obsidian"];
  }

  async inspectClaudeCode(): Promise<ClaudeCodeInspection> {
    const [claudeProbe, obsidianProbe] = await Promise.all([
      this.probe(this.claudeCandidates(), ["--version"], parseClaudeVersion),
      this.probe(this.obsidianCandidates(), ["version"], parseLooseVersion),
    ]);
    const claude = claudeProbe.result;
    const obsidian = obsidianProbe.result;
    this.claudeExecutable = claudeProbe.executable ?? "claude";
    if (!claude.available) return { claude, obsidian, marketplaceInstalled: false, pluginInstalled: false, pluginEnabled: false };

    try {
      const marketplaces = await this.options.exec.run(this.claudeExecutable, ["plugin", "marketplace", "list", "--json"], COMMAND_OPTIONS);
      const plugins = await this.options.exec.run(this.claudeExecutable, ["plugin", "list", "--json"], COMMAND_OPTIONS);
      const marketplaceIds = parseMarketplaceList(marketplaces.stdout);
      const pluginStates = parsePluginList(plugins.stdout);
      const obsidianAgent = pluginStates.find(({ id }) => id === "obsidian-agent@cavi" || id.startsWith("obsidian-agent@"));
      return {
        claude,
        obsidian,
        marketplaceInstalled: marketplaceIds.some((id) => id === "plugins" || id === "cavi" || id === "cavi-ai/plugins"),
        pluginInstalled: !!obsidianAgent,
        pluginEnabled: obsidianAgent?.enabled ?? false,
      };
    } catch (cause) {
      throw commandError("Check Claude Code integration", cause);
    }
  }

  async setupClaudeCode(): Promise<ClaudeCodeInspection> {
    const before = await this.inspectClaudeCode();
    for (const command of claudeCodeSetupPlan(before)) {
      try {
        const executable = command.executable === "claude" ? this.claudeExecutable : command.executable;
        await this.options.exec.run(executable, command.args, { ...COMMAND_OPTIONS, timeoutMs: 30_000 });
      } catch (cause) {
        throw commandError(command.stage, cause);
      }
    }
    const after = await this.inspectClaudeCode();
    if (!after.pluginInstalled || !after.pluginEnabled) {
      throw new DesktopIntegrationError("Verify obsidian-agent", "Claude Code did not report obsidian-agent as installed and enabled.");
    }
    return after;
  }

  async installClaudeDesktop(input: ClaudeDesktopInstallInput): Promise<ClaudeDesktopInstallResult> {
    if (!input.token.trim()) throw new DesktopIntegrationError("Configure Claude Desktop", "The MCP bridge token is empty.");
    const configPath = input.configPath ?? claudeDesktopConfigPath(
      this.options.platform,
      this.options.homeDir,
      this.options.env ?? {},
    );
    const current = await this.options.fs.read(configPath);
    const body = mergeClaudeDesktopConfig(current, {
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        `http://127.0.0.1:${input.port}/mcp`,
        "--header",
        `Authorization: Bearer ${input.token}`,
      ],
    });
    const backupPath = await this.options.fs.backup(configPath);
    await this.options.fs.atomicWrite(configPath, body);
    return { configPath, backupPath, restartRequired: true };
  }

  async openTerminalAtVault(vaultPath: string): Promise<TerminalLaunchResult> {
    const cwdOptions = { ...COMMAND_OPTIONS, cwd: vaultPath };
    const attempts: Array<{ executable: string; args: string[] }> = this.options.platform === "darwin"
      ? [{ executable: "/usr/bin/open", args: ["-a", "Terminal", vaultPath] }]
      : this.options.platform === "win32"
        ? [{ executable: "wt.exe", args: ["-d", vaultPath] }]
        : this.options.platform === "linux"
          ? [
              { executable: "x-terminal-emulator", args: ["--working-directory", vaultPath] },
              { executable: "gnome-terminal", args: [`--working-directory=${vaultPath}`] },
            ]
          : [];
    for (const attempt of attempts) {
      try {
        await this.options.exec.run(attempt.executable, attempt.args, cwdOptions);
        return { opened: true };
      } catch {
        // Try the next fixed launcher; the final fallback is copy-only.
      }
    }
    return { opened: false, instruction: `cd ${quoteForDisplay(vaultPath)} && claude` };
  }
}

function quoteForDisplay(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function createNodeDesktopRuntime(
  platform: DesktopPlatform,
  homeDir: string,
  env: Record<string, string | undefined>,
): Promise<DesktopRuntime> {
  // Obsidian's renderer exposes Node through Electron's require boundary.
  // Leaving dynamic `import("node:…")` in the CJS bundle delegates it to
  // Chromium, which cannot fetch Node builtins and prevents the modal opening.
  const nodeRequire = (window as { require: (module: string) => unknown }).require;
  const { execFile } = nodeRequire("node:child_process") as typeof import("node:child_process");
  const fs = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");
  const path = nodeRequire("node:path") as typeof import("node:path");
  const nodeProcess = nodeRequire("node:process") as typeof import("node:process");

  const errorCode = (cause: unknown): string | undefined =>
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;

  const exec: ExecFilePort = {
    run(executable, args, options) {
      return new Promise((resolve, reject) => {
        execFile(executable, args, {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: options.maxBytes,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(error.message, { cause: error }));
          else resolve({ stdout, stderr });
        });
      });
    },
  };

  const desktopFs: DesktopFsPort = {
    async read(target) {
      try {
        return await fs.readFile(target, "utf8");
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return null;
        throw cause;
      }
    },
    async backup(target) {
      try {
        await fs.access(target);
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return null;
        throw cause;
      }
      const backup = `${target}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.copyFile(target, backup);
      return backup;
    },
    async atomicWrite(target, body) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${nodeProcess.pid}-${Date.now()}`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(body, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, target);
      } catch (cause) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw cause;
      }
    },
  };

  return new DesktopRuntime({ exec, fs: desktopFs, platform, homeDir, env });
}
