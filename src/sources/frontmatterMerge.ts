import { App, TFile } from "obsidian";
import type { FrontmatterData } from "../indexing/frontmatter";

/**
 * Merge source-owned frontmatter keys into a note via Obsidian's processFrontMatter,
 * which preserves the note body and any keys we don't touch.
 */
export async function applySourceFrontmatter(app: App, file: TFile, fm: FrontmatterData): Promise<void> {
  await app.fileManager.processFrontMatter(file, (existing: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(fm)) {
      if (v !== undefined) existing[k] = v;
    }
  });
}
