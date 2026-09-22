// Small vault-file helpers shared by artifactStore, memory notes, the MCP
// vault tools, and main.ts — one implementation instead of four copies.

import { App, normalizePath, TFile } from "obsidian";

/** Create `folder` (and any missing parents) segment by segment; races are tolerated. */
export async function ensureVaultFolder(app: App, folder: string): Promise<void> {
  const path = normalizePath(folder);
  if (path === "" || path === "/" || app.vault.getAbstractFileByPath(path)) return;
  let cur = "";
  for (const part of path.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        /* race: created concurrently */
      }
    }
  }
}

/**
 * First free path for `safeBase.ext` in `folder` ("name 2.md", "name 3.md", …
 * on collision). The base must already be filename-safe — sanitizing is the
 * caller's job (artifact titles and MCP note titles sanitize differently).
 */
export async function uniqueNotePath(app: App, folder: string, safeBase: string, ext: string, firstSuffix = 2): Promise<string> {
  const dir = folder.replace(/\/+$/, "");
  const join = (name: string) => normalizePath(dir ? `${dir}/${name}` : name);
  let path = join(`${safeBase}.${ext}`);
  let i = firstSuffix;
  while (app.vault.getAbstractFileByPath(path)) {
    path = join(`${safeBase} ${i}.${ext}`);
    i++;
  }
  return path;
}

/** Overwrite the file at `path` when it exists, otherwise create it. */
export async function writeOrReplaceFile(app: App, path: string, content: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return app.vault.create(path, content);
}
