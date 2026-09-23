// Applies organize moves independently: a failed rename is recorded and the rest still run.

import { App, TFile } from "obsidian";
import { ensureVaultFolder } from "../vault/vaultFiles";
import type { OrganizeMove } from "./organize";

export async function applyOrganizeMoves(
  app: App,
  moves: OrganizeMove[],
): Promise<{ moved: number; failed: { from: string; error: string }[] }> {
  let moved = 0;
  const failed: { from: string; error: string }[] = [];
  for (const move of moves) {
    const file = app.vault.getAbstractFileByPath(move.from);
    if (!(file instanceof TFile)) {
      failed.push({ from: move.from, error: "note no longer exists" });
      continue;
    }
    try {
      const dir = move.to.slice(0, move.to.lastIndexOf("/"));
      await ensureVaultFolder(app, dir);
      await app.fileManager.renameFile(file, move.to);
      moved++;
    } catch (e) {
      failed.push({ from: move.from, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { moved, failed };
}
