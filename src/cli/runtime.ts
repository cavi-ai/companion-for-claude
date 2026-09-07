// Desktop-only ports for the Claude Code backend. Node comes from window.require so this file loads on mobile without executing.

import type { CliChild } from "./session";
import { claudeExecutableCandidates } from "../integrations/desktopRuntime";
import type { DesktopPlatform } from "../integrations/desktop";

export interface CliAuthStatus {
  loggedIn: boolean;
  method: string;
}

export interface ClaudeCliRuntime {
  findClaude(): Promise<{ executable: string; version: string } | null>;
  authStatus(executable: string): Promise<CliAuthStatus>;
  /** 0600 file in the OS temp dir; removed by removeFile. Never inside the vault. */
  writeSystemPromptFile(text: string): Promise<string>;
  removeFile(path: string): Promise<void>;
  spawn(executable: string, argv: string[], cwd: string): CliChild;
}

export function parseAuthStatus(stdout: string): CliAuthStatus {
  try {
    const o = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    return { loggedIn: o.loggedIn === true, method: typeof o.authMethod === "string" ? o.authMethod : "" };
  } catch {
    return { loggedIn: false, method: "" };
  }
}

const PROBE_TIMEOUT_MS = 5_000;
const MISSING = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

export function createNodeCliRuntime(): ClaudeCliRuntime {
  const nodeRequire = (window as { require: (m: string) => unknown }).require;
  const { execFile, spawn } = nodeRequire("node:child_process") as typeof import("node:child_process");
  const fs = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");
  const os = nodeRequire("node:os") as typeof import("node:os");
  const path = nodeRequire("node:path") as typeof import("node:path");
  const crypto = nodeRequire("node:crypto") as typeof import("node:crypto");
  const proc = nodeRequire("node:process") as typeof import("node:process");
  const platform: DesktopPlatform = proc.platform === "darwin" || proc.platform === "win32" || proc.platform === "linux" ? proc.platform : "unsupported";

  const run = (executable: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(executable, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) reject(Object.assign(new Error(error.message), { code: (error as { code?: string }).code }));
        else resolve(stdout);
      });
    });

  return {
    async findClaude() {
      for (const executable of claudeExecutableCandidates(platform, os.homedir())) {
        try {
          const out = await run(executable, ["--version"]);
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
    async authStatus(executable) {
      try {
        return parseAuthStatus(await run(executable, ["auth", "status"]));
      } catch {
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
    spawn(executable, argv, cwd) {
      return spawn(executable, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: proc.env }) as unknown as CliChild;
    },
  };
}
