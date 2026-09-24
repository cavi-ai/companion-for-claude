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
  /** Locates the backend's binary (special-cased search paths for Claude; PATH-only for the others) and its version. */
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

/** Executable search paths: Claude gets its historically verified multi-path search, the others resolve via PATH only. */
export function executableCandidates(backend: CliBackend, platform: DesktopPlatform, homeDir: string): string[] {
  if (backend.id === "claude-cli") return claudeExecutableCandidates(platform, homeDir);
  return [backend.binary];
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
      execFile(executable, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) reject(Object.assign(new Error(error.message), { code: (error as { code?: string }).code }));
        else resolve(stdout);
      });
    });

  /** Never throws: a failed probe (missing binary, nonzero exit) resolves with whatever stdout came back. */
  const runProbe = (executable: string, args: string[]): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve) => {
      execFile(executable, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (!error) { resolve({ stdout, code: 0 }); return; }
        const code = (error as { code?: string | number }).code;
        resolve({ stdout, code: typeof code === "number" ? code : 1 });
      });
    });

  return {
    async find(backend) {
      for (const executable of executableCandidates(backend, platform, os.homedir())) {
        try {
          const out = await runVersionCheck(executable, ["--version"]);
          const version = out.trim().split(/\s+/, 1)[0] ?? "";
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
      return spawn(executable, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: env ? { ...proc.env, ...env } : proc.env }) as unknown as CliChild;
    },
  };
}
