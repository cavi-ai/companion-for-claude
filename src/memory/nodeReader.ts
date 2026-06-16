// Node-backed filesystem reader for Claude Code CLI sessions.
//
// DESKTOP-ONLY: this module imports node builtins (fs/os/path). It must be
// reached via a lazy `await import("./nodeReader")` behind a Platform.isMobile
// guard — never statically imported — or the plugin fails to load on mobile,
// where these builtins don't exist. The pure discovery logic lives in
// sessions.ts (no Node), which is safe to import anywhere.

import type { SessionFile, SessionReader } from "./sessions";

// Node builtins are pulled in at runtime via Electron's `window.require` rather
// than a static `import`, so the bundle never references them — that's what keeps
// the plugin loadable on mobile. This module only runs on desktop (it's reached
// through a lazy `await import()` behind a Platform.isMobile guard), where
// `window.require` exists.
const nodeRequire = (window as { require: (m: string) => unknown }).require;
const nodeFs = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");
const nodeOs = nodeRequire("node:os") as typeof import("node:os");
const nodePath = nodeRequire("node:path") as typeof import("node:path");

/** Absolute ~/.claude/projects root for the current user. */
export function defaultProjectsRoot(): string {
  return nodePath.join(nodeOs.homedir(), ".claude", "projects");
}

/** Real reader over the local filesystem (Electron/node). */
export const nodeSessionReader: SessionReader = {
  async listFiles(projectDir: string): Promise<SessionFile[]> {
    let names: string[];
    try {
      names = await nodeFs.readdir(projectDir);
    } catch {
      return []; // dir absent → no sessions for this vault
    }
    const out: SessionFile[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = nodePath.join(projectDir, name);
      try {
        const s = await nodeFs.stat(path);
        out.push({ id: name.replace(/\.jsonl$/, ""), path, mtimeMs: s.mtimeMs });
      } catch {
        // unreadable entry — skip
      }
    }
    return out;
  },
  read(path: string): Promise<string> {
    return nodeFs.readFile(path, "utf8");
  },
};
