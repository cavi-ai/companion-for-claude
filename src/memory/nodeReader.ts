// Node-backed filesystem reader for Claude Code CLI sessions.
//
// DESKTOP-ONLY: this module imports node builtins (fs/os/path). It must be
// reached via a lazy `await import("./nodeReader")` behind a Platform.isMobile
// guard — never statically imported — or the plugin fails to load on mobile,
// where these builtins don't exist. The pure discovery logic lives in
// sessions.ts (no Node), which is safe to import anywhere.

/* eslint-disable import/no-nodejs-modules -- desktop-only module, lazy-loaded behind Platform.isMobile (see header) */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/* eslint-enable import/no-nodejs-modules */
import type { SessionFile, SessionReader } from "./sessions";

/** Absolute ~/.claude/projects root for the current user. */
export function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** Real reader over the local filesystem (Electron/node). */
export const nodeSessionReader: SessionReader = {
  async listFiles(projectDir: string): Promise<SessionFile[]> {
    let names: string[];
    try {
      names = await readdir(projectDir);
    } catch {
      return []; // dir absent → no sessions for this vault
    }
    const out: SessionFile[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(projectDir, name);
      try {
        const s = await stat(path);
        out.push({ id: name.replace(/\.jsonl$/, ""), path, mtimeMs: s.mtimeMs });
      } catch {
        // unreadable entry — skip
      }
    }
    return out;
  },
  read(path: string): Promise<string> {
    return readFile(path, "utf8");
  },
};
