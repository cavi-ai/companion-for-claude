import { App, getAllTags } from "obsidian";
import { buildVocabulary, type Vocabulary } from "./vocabulary";

export function vaultTagEntries(app: App): Array<{ path: string; tags: string[] }> {
  const out: Array<{ path: string; tags: string[] }> = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const tags = (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, ""));
    if (tags.length > 0) out.push({ path: file.path, tags });
  }
  return out;
}

export function vaultVocabulary(app: App): Vocabulary {
  return buildVocabulary(vaultTagEntries(app));
}
