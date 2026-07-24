import { App, TFile } from "obsidian";
import type { FrontmatterData } from "../indexing/frontmatter";

/**
 * Merge source-owned frontmatter keys into a note via Obsidian's processFrontMatter,
 * which preserves the note body and any keys we don't touch.
 */
function unionTags(existing: unknown, added: unknown): string[] {
  const toList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? [v.trim()] : [];
  return [...new Set([...toList(existing), ...toList(added)])];
}

export async function applySourceFrontmatter(app: App, file: TFile, fm: FrontmatterData): Promise<void> {
  await app.fileManager.processFrontMatter(file, (existing: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(fm)) {
      if (v === undefined) continue;
      // Union tags so a clipper's own tags survive enrichment.
      if (k === "tags") {
        existing[k] = unionTags(existing[k], v);
        continue;
      }
      existing[k] = v;
    }
  });
}
