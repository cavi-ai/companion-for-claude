// Shared hybrid vault search: keyword scoring + reciprocal-rank fusion with
// semantic hits. Both the chat context assembler (vaultContext) and the MCP
// vault_search tool consumed hand-rolled copies of this; one home now.

import { App, getAllTags } from "obsidian";
import { bm25Score, matchesAny, snippetAround, termStats, tokenize, type TermStats } from "./search";
import { reciprocalRankFusion } from "../semantic/similarity";

export interface KeywordHit {
  path: string;
  score: number;
  snippet: string;
}

/** A semantic-search fn over the local index (chat context and MCP share it). */
export type SemanticSearch = (query: string, k: number, accept?: (path: string) => boolean) => Promise<{ path: string; text: string }[]>;

/** BM25-rank every markdown file (title + tags + body) the predicate accepts, best first. */
export async function keywordVaultSearch(app: App, query: string, excludePath: string | null = null, accept?: (path: string) => boolean): Promise<KeywordHit[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const matched: Array<{ path: string; stats: TermStats; snippet: string }> = [];
  const df = terms.map(() => 0);
  let docs = 0;
  let totalLength = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    if (file.path === excludePath) continue;
    if (accept && !accept(file.path)) continue;
    const cache = app.metadataCache.getFileCache(file);
    const tags = cache ? (getAllTags(cache) ?? []).join(" ") : "";
    const content = await app.vault.cachedRead(file);
    const stats = termStats(terms, file.path, tags, content);
    docs++;
    totalLength += stats.length;
    terms.forEach((_, i) => { if (stats.counts[i]! > 0 || stats.inPath[i] || stats.inTags[i]) df[i]!++; });
    if (matchesAny(stats)) matched.push({ path: file.path, stats, snippet: snippetAround(content, stats.firstIdx) });
  }
  const corpus = { docs, avgLength: totalLength / Math.max(1, docs), df };
  return matched
    .map(({ path, stats, snippet }) => ({ path, score: bm25Score(stats, corpus), snippet }))
    .sort((a, b) => b.score - a.score);
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
