import type { ProviderRouter } from "../providers/router";
import { parseTaggerOutput } from "./taggerParse";
import { resolveTags } from "../tags/resolve";
import { selectPromptTags, type Vocabulary } from "../tags/vocabulary";

export { parseTaggerOutput } from "./taggerParse";

export interface TagResult {
  tags: string[];
  /** Resolved tags that did not exist in the vault. */
  newTags: string[];
  summary: string;
  /** A short, descriptive title for the note's filename + heading. */
  title: string;
  /** Which provider produced these, for transparency in the UI. */
  via: string;
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
export async function summarizeAndTag(router: ProviderRouter, content: string, vocab: Vocabulary): Promise<TagResult> {
  const existing = selectPromptTags(vocab, content);
  const existingLine = existing.length > 0 ? `Existing tags (prefer these when relevant): ${existing.join(", ")}\n\n` : "";
  const body = content.length > 8000 ? content.slice(0, 8000) + "\n…[truncated]" : content;

  const { text: raw, provider } = await router.complete("utility", {
    system: TAG_SYSTEM,
    user: `${existingLine}Document:\n\n${body}`,
    maxTokens: 240,
  });

  const parsed = parseTaggerOutput(raw);
  const resolved = resolveTags(parsed.tags, vocab);
  return {
    ...parsed,
    tags: resolved.map((r) => r.tag),
    newTags: resolved.filter((r) => r.match === "new").map((r) => r.tag),
    via: provider.label,
  };
}
