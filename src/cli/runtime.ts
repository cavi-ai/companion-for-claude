// Desktop-only ports shared by every CLI chat backend. Node comes from window.require so this file loads on mobile without executing.

import type { CliChild } from "./session";
import type { CliBackend } from "./backends/types";
import { claudeExecutableCandidates } from "../integrations/desktopRuntime";
import type { DesktopPlatform } from "../integrations/desktop";

export interface CliAuthStatus {
  loggedIn: boolean;
  method: string;
}

export interface CliRuntime {
  /** Locates the backend's binary (Claude's install locations, then the login-shell PATH and common install dirs) and its version. */
  find(backend: CliBackend): Promise<{ executable: string; version: string } | null>;
  /** Runs the backend's own auth probe against the found executable. */
  probe(backend: CliBackend, executable: string): Promise<CliAuthStatus>;
  /** 0600 file in the OS temp dir; removed by removeFile. Never inside the vault. Persistent backends only. */
  writeSystemPromptFile(text: string): Promise<string>;
  removeFile(path: string): Promise<void>;
  spawn(executable: string, argv: string[], cwd: string, env?: Record<string, string>): CliChild;
}

export function parseAuthStatus(stdout: string): CliAuthStatus {
  try {
    const o = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    return { loggedIn: o.loggedIn === true, method: typeof o.authMethod === "string" ? o.authMethod : "" };
  } catch (e) {
    console.debug("Claude Companion: CLI auth status JSON parse failed", e);
    return { loggedIn: false, method: "" };
  }
}

const PROBE_TIMEOUT_MS = 5_000;
const MISSING = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

const SHELL_PATH_MARKER = "__CC_PATH__";
const SHELL_PATH_TIMEOUT_MS = 5_000;

/** The PATH a login shell prints between markers; rc files may print anything around it. */
export function parseShellPath(stdout: string): string[] {
  const start = stdout.indexOf(SHELL_PATH_MARKER);
  const end = stdout.indexOf(SHELL_PATH_MARKER, start + SHELL_PATH_MARKER.length);
  if (start < 0 || end < 0) return [];
  return stdout.slice(start + SHELL_PATH_MARKER.length, end).split(":").filter(Boolean);
}

export function parseVersion(stdout: string): string {
  const tokens = stdout.trim().split(/\s+/);
  return tokens.find((t) => /^v?\d+\.\d+/.test(t)) ?? tokens[0] ?? "";
}

/** GUI-launched apps on macOS get only /usr/bin:/bin:/usr/sbin:/sbin, so the login shell's PATH and common install dirs are searched too. */
export function searchDirs(platform: DesktopPlatform, homeDir: string, shellPath: string[], envPath: string): string[] {
  if (platform === "win32") return [];
  const common = ["/opt/homebrew/bin", "/usr/local/bin", `${homeDir}/.local/bin`, `${homeDir}/.bun/bin`, `${homeDir}/.opencode/bin`, `${homeDir}/.npm-global/bin`];
  return [...new Set([...envPath.split(":"), ...shellPath, ...common].filter(Boolean))];
}

/** Claude keeps its verified install locations first; every backend then tries each search dir. */
export function executableCandidates(backend: CliBackend, platform: DesktopPlatform, homeDir: string, dirs: string[] = []): string[] {
  const head = backend.id === "claude-cli" ? claudeExecutableCandidates(platform, homeDir) : [backend.binary];
  return [...new Set([...head, ...dirs.map((d) => `${d}/${backend.binary}`)])];
}

export function createNodeCliRuntime(): CliRuntime {
  const nodeRequire = (window as { require: (m: string) => unknown }).require;
  const { execFile, spawn } = nodeRequire("node:child_process") as typeof import("node:child_process");
  const fs = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");
  const os = nodeRequire("node:os") as typeof import("node:os");
  const path = nodeRequire("node:path") as typeof import("node:path");
  const crypto = nodeRequire("node:crypto") as typeof import("node:crypto");
  const proc = nodeRequire("node:process") as typeof import("node:process");
  const platform: DesktopPlatform = proc.platform === "darwin" || proc.platform === "win32" || proc.platform === "linux" ? proc.platform : "unsupported";

  const runVersionCheck = (executable: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(executable, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: childEnv() }, (error, stdout) => {
        if (error) reject(Object.assign(new Error(error.message), { code: (error as { code?: string }).code }));
        else resolve(stdout);
      });
    });

  /** Never throws: a failed probe (missing binary, nonzero exit) resolves with whatever output came back. */
  const runProbe = (executable: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
    new Promise((resolve) => {
      execFile(executable, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: childEnv() }, (error, stdout, stderr) => {
        if (!error) { resolve({ stdout, stderr, code: 0 }); return; }
        const code = (error as { code?: string | number }).code;
        resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
      });
    });

  let shellPath: Promise<string[]> | null = null;
  const loginShellPath = (): Promise<string[]> => {
    if (platform === "win32" || platform === "unsupported") return Promise.resolve([]);
    shellPath ??= new Promise((resolve) => {
      const shell = proc.env.SHELL || "/bin/zsh";
      execFile(shell, ["-ilc", `printf '%s%s%s' '${SHELL_PATH_MARKER}' "$PATH" '${SHELL_PATH_MARKER}'`], { timeout: SHELL_PATH_TIMEOUT_MS }, (error, stdout) => {
        const found = parseShellPath(stdout ?? "");
        if (found.length === 0) {
          console.debug("Claude Companion: login shell PATH lookup failed", error);
          shellPath = null;
        }
        resolve(found);
      });
    });
    return shellPath;
  };
  let dirs: string[] = [];
  const childEnv = (extra?: Record<string, string>): NodeJS.ProcessEnv => {
    const env = { ...proc.env, ...extra };
    if (dirs.length > 0) env.PATH = dirs.join(":");
    return env;
  };

  return {
    async find(backend) {
      dirs = searchDirs(platform, os.homedir(), await loginShellPath(), proc.env.PATH ?? "");
      for (const executable of executableCandidates(backend, platform, os.homedir(), dirs)) {
        try {
          const out = await runVersionCheck(executable, ["--version"]);
          const version = parseVersion(out);
          if (version) return { executable, version };
        } catch (cause) {
          const code = (cause as { code?: string }).code;
          if (code && MISSING.has(code)) continue;
          return null;
        }
      }
      return null;
    },
    async probe(backend, executable) {
      try {
        return await backend.probe((argv) => runProbe(executable, argv));
      } catch (e) {
        console.debug("Claude Companion: CLI auth probe failed", e);
        return { loggedIn: false, method: "" };
      }
    },
    async writeSystemPromptFile(text) {
      const file = path.join(os.tmpdir(), `claude-companion-${crypto.randomUUID()}.md`);
      await fs.writeFile(file, text, { mode: 0o600 });
      return file;
    },
    async removeFile(file) {
      await fs.rm(file, { force: true });
    },
    spawn(executable, argv, cwd, env) {
      return spawn(executable, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: childEnv(env) }) as unknown as CliChild;
    },
  };
}
