import { App, MarkdownView, TFile, getAllTags } from "obsidian";
import type { ContextToggles, PluginSettings } from "../types";
import { clip, scoreContent, section, snippetAround, tokenize } from "./search";
import { reciprocalRankFusion } from "../semantic/similarity";

export interface GatheredContext {
  text: string;
  /** Short human-readable labels of what was attached, for the UI. */
  sources: string[];
}

/** Optional semantic retriever (local embeddings); absent → keyword-only. */
export type SemanticSearch = (query: string, k: number) => Promise<{ path: string; text: string }[]>;

/** A note or folder explicitly attached via the "@" picker. */
export interface AttachedPath {
  path: string;
  kind: "note" | "folder";
}

/**
 * Build a context string from the vault based on the active note, the current
 * selection, linked notes, and (optionally) a hybrid keyword+semantic search.
 */
export async function gatherContext(
  app: App,
  settings: PluginSettings,
  toggles: ContextToggles,
  userQuery: string,
  semanticSearch?: SemanticSearch,
  attachedPaths: AttachedPath[] = [],
): Promise<GatheredContext> {
  const sources: string[] = [];
  const blocks: string[] = [];
  let budget = settings.contextCharBudget;

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const activeFile = view?.file ?? app.workspace.getActiveFile();

  // 1. Current selection (highest priority).
  if (toggles.selection && view) {
    const sel = view.editor.getSelection();
    if (sel && sel.trim().length > 0) {
      const block = section(`Selected text from "${activeFile?.basename ?? "current note"}"`, sel.trim());
      blocks.push(clip(block, budget));
      budget -= block.length;
      sources.push("selection");
    }
  }

  // 2. Active note.
  if (toggles.activeNote && activeFile instanceof TFile && budget > 0) {
    const content = await app.vault.cachedRead(activeFile);
    const block = section(`Current note: ${activeFile.path}`, content);
    blocks.push(clip(block, budget));
    budget -= Math.min(block.length, budget);
    sources.push("active note");
  }

  // 2b. Explicitly @-attached notes / folders (a folder pulls its notes in).
  if (attachedPaths.length > 0 && budget > 0) {
    let added = 0;
    for (const att of attachedPaths) {
      if (budget <= 0) break;
      const files =
        att.kind === "folder"
          ? folderMarkdown(app, att.path, settings.maxContextNotes)
          : ((f) => (f instanceof TFile ? [f] : []))(app.vault.getAbstractFileByPath(att.path));
      for (const f of files) {
        if (budget <= 0) break;
        const content = await app.vault.cachedRead(f);
        const block = section(`Attached: ${f.path}`, content);
        const clipped = clip(block, Math.min(budget, 6000));
        blocks.push(clipped);
        budget -= clipped.length;
        added++;
      }
    }
    if (added > 0) sources.push(`${added} attached`);
  }

  // 3. Linked + backlinked notes.
  if (toggles.linkedNotes && activeFile instanceof TFile && budget > 0) {
    const linked = collectLinkedFiles(app, activeFile, settings.maxContextNotes);
    let added = 0;
    for (const f of linked) {
      if (budget <= 0) break;
      const content = await app.vault.cachedRead(f);
      const block = section(`Linked note: ${f.path}`, content);
      const clipped = clip(block, Math.min(budget, 4000));
      blocks.push(clipped);
      budget -= clipped.length;
      added++;
    }
    if (added > 0) sources.push(`${added} linked note${added > 1 ? "s" : ""}`);
  }

  // 4. Vault search (hybrid: keyword + semantic, fused). Falls back to keyword
  //    when no semantic retriever is wired or the local index is unavailable.
  if (toggles.searchVault && userQuery.trim().length > 0 && budget > 0) {
    const exclude = activeFile instanceof TFile ? activeFile.path : null;
    const keyword = await searchVault(app, userQuery, settings.maxContextNotes, exclude);
    let semantic: { path: string; text: string }[] = [];
    if (semanticSearch) {
      try {
        semantic = (await semanticSearch(userQuery, settings.maxContextNotes)).filter((s) => s.path !== exclude);
      } catch {
        // local index/Ollama unavailable → keyword-only, no regression
      }
    }
    const fused = fuseHits(keyword, semantic, settings.maxContextNotes);
    let added = 0;
    for (const item of fused) {
      if (budget <= 0) break;
      const block = section(`Search match: ${item.path}`, item.snippet);
      const clipped = clip(block, Math.min(budget, 3000));
      blocks.push(clipped);
      budget -= clipped.length;
      added++;
    }
    if (added > 0) {
      sources.push(`${added} ${semantic.length ? "semantic" : "search"} match${added > 1 ? "es" : ""}`);
      // Ask for click-through citations to the source notes (the 1.2 "ask your
      // vault with citations" behavior). Count it against the budget so context
      // never exceeds contextCharBudget; drop it if there's no room left.
      const citation =
        'When you draw on the "Search match" notes above, cite each inline as an ' +
        "Obsidian wikilink — [[Note Name]], using the note's file name without the " +
        "folder path or .md extension — so the reader can click through to the source.";
      if (budget >= citation.length) {
        blocks.push(citation);
        budget -= citation.length;
      }
    }
  }

  if (blocks.length === 0) return { text: "", sources: [] };
  const text = ["<vault_context>", ...blocks, "</vault_context>"].join("\n\n");
  return { text, sources };
}

/** Markdown files directly under a folder path (newest first), capped at `limit`. */
function folderMarkdown(app: App, folderPath: string, limit: number): TFile[] {
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  return app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(prefix))
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, limit);
}

function collectLinkedFiles(app: App, file: TFile, limit: number): TFile[] {
  const out: TFile[] = [];
  const seen = new Set<string>([file.path]);

  const push = (path: string) => {
    if (seen.has(path) || out.length >= limit) return;
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile && f.extension === "md") {
      seen.add(path);
      out.push(f);
    }
  };

  // Outgoing links.
  const resolved = app.metadataCache.resolvedLinks[file.path] ?? {};
  for (const target of Object.keys(resolved)) push(target);

  // Backlinks.
  for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (out.length >= limit) break;
    if (targets[file.path]) push(source);
  }

  return out.slice(0, limit);
}

interface SearchHit {
  file: TFile;
  score: number;
  snippet: string;
}

/**
 * Fuse keyword + semantic hits into one note-deduped, ranked list via reciprocal
 * rank fusion. Each note keeps the best snippet we have (keyword match excerpt,
 * else the semantic chunk text).
 */
function fuseHits(keyword: SearchHit[], semantic: { path: string; text: string }[], limit: number): { path: string; snippet: string }[] {
  const snippet = new Map<string, string>();
  for (const k of keyword) if (!snippet.has(k.file.path)) snippet.set(k.file.path, k.snippet);
  for (const s of semantic) if (!snippet.has(s.path)) snippet.set(s.path, s.text);

  const fused = reciprocalRankFusion([
    keyword.map((h) => ({ id: h.file.path, score: h.score })),
    semantic.map((s) => ({ id: s.path, score: 1 })),
  ]);
  return fused
    .slice(0, limit)
    .map((f) => ({ path: f.id, snippet: snippet.get(f.id) ?? "" }))
    .filter((x) => x.snippet);
}

/** Lightweight keyword scoring over markdown files — no embeddings required. */
async function searchVault(app: App, query: string, limit: number, excludePath: string | null): Promise<SearchHit[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const files = app.vault.getMarkdownFiles();
  const hits: SearchHit[] = [];

  for (const file of files) {
    if (file.path === excludePath) continue;

    const cache = app.metadataCache.getFileCache(file);
    const lowerTags = cache ? (getAllTags(cache) ?? []).join(" ").toLowerCase() : "";
    const content = await app.vault.cachedRead(file);
    const { score, firstIdx } = scoreContent(terms, file.path.toLowerCase(), lowerTags, content);

    if (score > 0) {
      hits.push({ file, score, snippet: snippetAround(content, firstIdx) });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
