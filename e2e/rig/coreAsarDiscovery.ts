// Where Obsidian keeps the cores it auto-updates into, and which one is newest.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { newestCoreAsar } from "../coreAsar.ts";

function obsidianUserDataDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "obsidian");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian");
}

/**
 * The newest core Obsidian has already downloaded. The installed .app is only a
 * shell and loads this at runtime, so without it the harness reads the bundle's
 * version and refuses to run against a machine that is in fact up to date.
 */
export async function discoverCoreAsar(): Promise<string | undefined> {
  const dir = obsidianUserDataDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const newest = newestCoreAsar(names);
  return newest ? join(dir, newest) : undefined;
}
