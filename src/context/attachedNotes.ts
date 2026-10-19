import { TFile, TFolder, type App } from "obsidian";
import type { AttachedPath } from "./vaultContext";

export interface PreparedAttachedNote { path: string; content: string }

/** Preserve the existing newest-first folder cap when expanding selected folders. */
export function folderMarkdown(app: Pick<App, "vault">, folderPath: string, limit: number): TFile[] {
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  return app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix)).sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, limit);
}

/** Capture selected note contents before durable acceptance, or refuse the whole request. */
export async function loadAttachedNotes(app: Pick<App, "vault">, paths: readonly AttachedPath[], limit: number): Promise<PreparedAttachedNote[]> {
  const notes: PreparedAttachedNote[] = [];
  for (const selected of paths) {
    try {
      const entry = app.vault.getAbstractFileByPath(selected.path);
      let files: TFile[];
      if (selected.kind === "folder") {
        if (!(entry instanceof TFolder)) throw new Error("source not found");
        files = folderMarkdown(app, selected.path, limit);
      } else {
        if (!(entry instanceof TFile)) throw new Error("source not found");
        files = [entry];
      }
      for (const file of files) notes.push({ path: file.path, content: await app.vault.cachedRead(file) });
    } catch (error) {
      throw new Error(`Couldn't attach ${selected.path}: ${error instanceof Error ? error.message : String(error)}. Reattach it or remove it from Message context, then send again.`, { cause: error });
    }
  }
  return notes;
}
