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
import type { ManagedProcessPort } from "../build/desktopExecutor";

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

interface ProcessStreamLike {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  off(event: "data", listener: (chunk: unknown) => void): unknown;
}

interface ManagedChildLike {
  stdout?: ProcessStreamLike | null;
  stderr?: ProcessStreamLike | null;
  once(event: "error" | "close", listener: (...args: unknown[]) => void): unknown;
  off(event: "error" | "close", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): boolean;
}

export type SpawnPort = (executable: string, args: string[], options: { cwd: string; windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ManagedChildLike;

export interface ProcessTimerPort {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export function managedProcessPortFromSpawn(spawn: SpawnPort, timers: ProcessTimerPort): ManagedProcessPort {
  return {
    run(executable, args, options) {
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        let child: ManagedChildLike;
        try {
          child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
          return;
        }
        let stderr = "";
        let settled = false;
        let abortRequested = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        const onStdout = (chunk: unknown): void => options.onStdout(String(chunk));
        const onStderr = (chunk: unknown): void => { const text = String(chunk); stderr = `${stderr}${text}`.slice(-8_000); options.onStderr(text); };
        const cleanup = (): void => {
          if (killTimer !== null) {
            timers.clearTimeout(killTimer);
            killTimer = null;
          }
          child.stdout?.off("data", onStdout);
          child.stderr?.off("data", onStderr);
          child.off("error", onError);
          child.off("close", onClose);
          options.signal.removeEventListener("abort", onAbort);
        };
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const abortError = (): DOMException => new DOMException("aborted", "AbortError");
        const onError = (cause: unknown): void => finish(() => reject(abortRequested ? abortError() : cause instanceof Error ? cause : new Error(String(cause))));
        const onClose = (code: unknown): void => finish(() => {
          if (abortRequested) reject(abortError());
          else resolve({ code: typeof code === "number" ? code : 1, stderr });
        });
        const onAbort = (): void => {
          if (abortRequested || settled) return;
          abortRequested = true;
          try {
            if (!child.kill("SIGTERM")) {
              finish(() => reject(abortError()));
              return;
            }
            killTimer = timers.setTimeout(() => {
              killTimer = null;
              try {
                if (!child.kill("SIGKILL")) finish(() => reject(abortError()));
              } catch {
                finish(() => reject(abortError()));
              }
            }, 2_000);
          } catch {
            finish(() => reject(abortError()));
          }
        };
        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
        child.once("error", onError);
        child.once("close", onClose);
        options.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
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

  async resolveClaudeCodeExecutable(): Promise<string> {
    const inspection = await this.inspectClaudeCode();
    if (!inspection.claude.available) throw new DesktopIntegrationError("Start build", "Claude Code was not found. Open Desktop integrations to install it.");
    return this.claudeExecutable;
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

export function createNodeManagedProcessPort(): ManagedProcessPort {
  const nodeRequire = (window as { require: (module: string) => unknown }).require;
  const { spawn } = nodeRequire("node:child_process") as typeof import("node:child_process");
  return managedProcessPortFromSpawn(spawn as unknown as SpawnPort, window);
}
