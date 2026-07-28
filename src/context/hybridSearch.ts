// Shared hybrid vault search: keyword scoring + reciprocal-rank fusion with
// semantic hits. Both the chat context assembler (vaultContext) and the MCP
// vault_search tool consumed hand-rolled copies of this; one home now.

import { App, getAllTags } from "obsidian";
import { scoreContent, snippetAround, tokenize } from "./search";
import { reciprocalRankFusion } from "../semantic/similarity";

export interface KeywordHit {
  path: string;
  score: number;
  snippet: string;
}

/** A semantic-search fn over the local index (chat context and MCP share it). */
export type SemanticSearch = (query: string, k: number) => Promise<{ path: string; text: string }[]>;

/** Keyword-score every markdown file (paths + tags + content), best first. */
export async function keywordVaultSearch(app: App, query: string, excludePath: string | null = null): Promise<KeywordHit[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: KeywordHit[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (file.path === excludePath) continue;
    const cache = app.metadataCache.getFileCache(file);
    const lowerTags = cache ? (getAllTags(cache) ?? []).join(" ").toLowerCase() : "";
    const content = await app.vault.cachedRead(file);
    const { score, firstIdx } = scoreContent(terms, file.path.toLowerCase(), lowerTags, content);
    if (score > 0) hits.push({ path: file.path, score, snippet: snippetAround(content, firstIdx) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Fuse keyword + semantic hits into one note-deduped, ranked list via
 * reciprocal rank fusion. Each note keeps the best snippet we have (keyword
 * match excerpt, else the semantic chunk text); snippet-less hits are dropped.
 */
export function fuseKeywordAndSemantic(
  keyword: KeywordHit[],
  semantic: { path: string; text: string }[],
  limit: number,
): { path: string; snippet: string }[] {
  const snippet = new Map<string, string>();
  for (const k of keyword) if (!snippet.has(k.path)) snippet.set(k.path, k.snippet);
  for (const s of semantic) if (!snippet.has(s.path)) snippet.set(s.path, s.text);
  return reciprocalRankFusion([
    keyword.map((h) => ({ id: h.path, score: h.score })),
    semantic.map((s) => ({ id: s.path, score: 1 })),
  ])
    .slice(0, limit)
    .map((f) => ({ path: f.id, snippet: snippet.get(f.id) ?? "" }))
    .filter((x) => x.snippet);
}
