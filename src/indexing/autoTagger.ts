import { App, getAllTags } from "obsidian";
import type { ProviderRouter } from "../providers/router";
import { parseTaggerOutput } from "./taggerParse";

export { parseTaggerOutput } from "./taggerParse";

export interface TagResult {
  tags: string[];
  summary: string;
  /** A short, descriptive title for the note's filename + heading. */
  title: string;
  /** Which provider produced these, for transparency in the UI. */
  via: string;
}

/** Collect existing vault tags so the model can prefer reusing them. */
export function existingVaultTags(app: App, limit = 80): string[] {
  const counts = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    for (const t of getAllTags(cache) ?? []) {
      const tag = t.replace(/^#/, "");
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

const TAG_SYSTEM =
  "You are a precise knowledge-base indexer. Given a document, reply with EXACTLY three lines:\n" +
  "TITLE: a short, specific, descriptive title for this note (max 8 words, no quotes, no trailing punctuation). Describe the content, not the request.\n" +
  "TAGS: a comma-separated list of 4-8 lowercase topic tags (no # symbol, use-hyphens-for-spaces)\n" +
  "SUMMARY: one concise sentence (max 25 words).\n" +
  "Prefer reusing tags from the provided existing-tags list when they fit. No other text.";

/**
 * Summarize + tag a document. Routes to the local (utility) provider when
 * enabled — keeping this cheap, bulk work off the Anthropic bill.
 */
export async function summarizeAndTag(app: App, router: ProviderRouter, content: string, existing: string[]): Promise<TagResult> {
  const { provider, model } = router.resolve("utility");
  const existingLine = existing.length > 0 ? `Existing tags (prefer these when relevant): ${existing.join(", ")}\n\n` : "";
  const body = content.length > 8000 ? content.slice(0, 8000) + "\n…[truncated]" : content;

  const raw = await provider.complete({
    system: TAG_SYSTEM,
    model,
    maxTokens: 240,
    temperature: 0,
    messages: [{ role: "user", content: `${existingLine}Document:\n\n${body}` }],
  });

  return { ...parseTaggerOutput(raw), via: provider.label };
}
