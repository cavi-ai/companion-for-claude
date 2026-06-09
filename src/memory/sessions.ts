// Filesystem-backed discovery of Claude Code CLI sessions for a vault. The FS is
// reached through an injected SessionReader so the discovery logic is unit-tested
// against fixtures; the real reader (node fs) is desktop-only. Pure helpers
// (encodeProjectDir, metaFromTranscript) carry no IO.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { digestTranscript } from "./transcript";

/**
 * Encode an absolute cwd into the directory name Claude Code uses under
 * ~/.claude/projects/. Confirmed on-disk: every non-alphanumeric char → "-"
 * (so "/a/.b" → "-a--b"). Lossy in reverse — we match the exact `cwd` field
 * inside the records, not by decoding this name.
 */
export function encodeProjectDir(vaultPath: string): string {
  return vaultPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** One discovered transcript file (cheap stat, no parse yet). */
export interface SessionFile {
  id: string; // the <id> in <id>.jsonl — a stable handle
  path: string; // absolute path to the .jsonl
  mtimeMs: number;
}

/** Parsed, list-ready metadata for a session. */
export interface SessionMeta extends SessionFile {
  sessionId?: string;
  model?: string;
  gitBranch?: string;
  cwd?: string;
  startedAt?: string;
  userTurns: number;
  /** First user prose line, truncated — the picker's label. */
  preview: string;
}

/** Injected IO boundary; real impl uses node fs (desktop), tests use fixtures. */
export interface SessionReader {
  listFiles(projectDir: string): Promise<SessionFile[]>;
  read(path: string): Promise<string>;
}

const PREVIEW_MAX = 120;

/** Build list metadata by parsing the transcript (reuses the one parser, DRY). */
export function metaFromTranscript(file: SessionFile, jsonl: string): SessionMeta {
  const d = digestTranscript(jsonl);
  const firstUser = d.prose.find((p) => p.role === "user")?.text ?? "";
  const preview = (firstUser.split("\n")[0] || file.id).slice(0, PREVIEW_MAX);
  return {
    ...file,
    sessionId: d.sessionId,
    model: d.model,
    gitBranch: d.gitBranch,
    cwd: d.cwd,
    startedAt: d.startedAt,
    userTurns: d.userTurns,
    preview,
  };
}

/**
 * List this vault's sessions, newest first. Scopes by the exact `cwd` field when
 * present (a session with no cwd is kept — better to show than silently drop).
 */
export async function listSessionsForVault(
  reader: SessionReader,
  vaultPath: string,
  projectsRoot: string,
): Promise<SessionMeta[]> {
  const dir = `${projectsRoot}/${encodeProjectDir(vaultPath)}`;
  const files = await reader.listFiles(dir);
  const metas = await Promise.all(
    files.map(async (f) => metaFromTranscript(f, await reader.read(f.path))),
  );
  return metas
    .filter((m) => !m.cwd || m.cwd === vaultPath)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Absolute ~/.claude/projects root for the current user. */
export function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** Real reader over the local filesystem. Desktop-only (Electron/node). */
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
