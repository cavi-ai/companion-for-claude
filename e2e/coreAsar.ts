// Pure version arithmetic behind the harness's Obsidian-core resolution. Kept
// free of Playwright and fs so it unit-tests directly.

/** Compare dotted versions; -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The version an `obsidian-<version>.asar` path or file name declares. */
export function coreAsarVersion(fileNameOrPath: string): string | undefined {
  const fileName = fileNameOrPath.split(/[\\/]/).pop() ?? fileNameOrPath;
  return /^obsidian-(\d+(?:\.\d+)+)\.asar$/.exec(fileName)?.[1];
}

/**
 * The newest official core Obsidian auto-updated into its user-data directory.
 * The installed .app is only a shell — it loads this at runtime — so the app
 * bundle's version understates what the machine can actually run.
 */
export function newestCoreAsar(fileNames: readonly string[]): string | undefined {
  let best: { name: string; version: string } | undefined;
  for (const name of fileNames) {
    const version = coreAsarVersion(name);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { name, version };
  }
  return best?.name;
}

/** Resolve the core version an isolated profile will load, including a supplied auto-update ASAR. */
export function effectiveObsidianCoreVersion(installed: string, coreAsarPath?: string): string {
  if (!coreAsarPath) return installed;
  const version = coreAsarVersion(coreAsarPath);
  if (!version) throw new Error(`OBSIDIAN_ASAR_PATH must name an obsidian-<version>.asar file: ${coreAsarPath}`);
  return compareVersions(version, installed) > 0 ? version : installed;
}
