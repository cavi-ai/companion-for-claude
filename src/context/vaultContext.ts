import { App, MarkdownView, TFile } from "obsidian";
import type { ContextToggles, PluginSettings } from "../types";
import { extractEdges } from "../ontology/relations";
import type { OntologyRegistry } from "../ontology/registry";
import { clip, section } from "./search";
import { fuseKeywordAndSemantic, keywordVaultSearch, type SemanticSearch } from "./hybridSearch";
import { MAX_RELATION_EXPANSION, noteType, planRelationExpansion, typeLabel } from "./typedContext";
import type { AttachedPage } from "./urlContext";

export interface GatheredContext {
  text: string;
  /** Short human-readable labels of what was attached, for the UI. */
  sources: string[];
}

/** Optional semantic retriever (local embeddings); absent → keyword-only. */
export type { SemanticSearch } from "./hybridSearch";

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
  attachedPages: AttachedPage[] = [],
  /** Restricts automatic vault search (keyword + semantic) to notes it accepts — e.g. a chat project's folder. */
  searchScope?: (path: string) => boolean,
  /** Loaded ontology; null or empty leaves the context untyped. */
  ontology?: Pick<OntologyRegistry, "resolve" | "resolved"> | null,
): Promise<GatheredContext> {
  const sources: string[] = [];
  const blocks: string[] = [];
  let budget = settings.contextCharBudget;
  const typed = ontology && ontology.resolved().size > 0 ? ontology : null;
  const label = (path: string): string => (typed ? typeLabel(noteType(frontmatterOf(app, path))) : "");
  const included = new Set<string>();

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const activeFile = view?.file ?? app.workspace.getActiveFile();
  if (activeFile instanceof TFile) included.add(activeFile.path);

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
        included.add(f.path);
        added++;
      }
    }
    if (added > 0) sources.push(`${added} attached`);
  }

  // 2c. Web pages attached via "Attach page content" (clean captured markdown).
  if (attachedPages.length > 0 && budget > 0) {
    let added = 0;
    for (const p of attachedPages) {
      if (budget <= 0) break;
      if (!p.markdown) continue; // pending or failed — the pill shows the state
      const block = section(`Web page: ${p.title ?? p.url} (${p.url})`, p.markdown);
      const clipped = clip(block, Math.min(budget, 6000));
      blocks.push(clipped);
      budget -= clipped.length;
      added++;
    }
    if (added > 0) sources.push(`${added} page${added > 1 ? "s" : ""}`);
  }

  // 3. Linked + backlinked notes.
  if (toggles.linkedNotes && activeFile instanceof TFile && budget > 0) {
    const linked = collectLinkedFiles(app, activeFile, settings.maxContextNotes);
    let added = 0;
    for (const f of linked) {
      if (budget <= 0) break;
      const content = await app.vault.cachedRead(f);
      const block = section(`Linked note: ${f.path}${label(f.path)}`, content);
      const clipped = clip(block, Math.min(budget, 4000));
      blocks.push(clipped);
      budget -= clipped.length;
      included.add(f.path);
      added++;
    }
    if (added > 0) sources.push(`${added} linked note${added > 1 ? "s" : ""}`);
  }

  // 4. Vault search (hybrid: keyword + semantic, fused). Falls back to keyword
  //    when no semantic retriever is wired or the local index is unavailable.
  if (toggles.searchVault && userQuery.trim().length > 0 && budget > 0) {
    const exclude = activeFile instanceof TFile ? activeFile.path : null;
    const keyword = (await keywordVaultSearch(app, userQuery, exclude, searchScope)).slice(0, settings.maxContextNotes);
    let semantic: { path: string; text: string }[] = [];
    if (semanticSearch) {
      try {
        semantic = (await semanticSearch(userQuery, settings.maxContextNotes, searchScope)).filter((s) => s.path !== exclude && (!searchScope || searchScope(s.path)));
      } catch {
        // local index/Ollama unavailable → keyword-only, no regression
      }
    }
    const fused = fuseKeywordAndSemantic(keyword, semantic, settings.maxContextNotes);
    const matched: string[] = [];
    for (const item of fused) {
      if (budget <= 0) break;
      const block = section(`Search match: ${item.path}${label(item.path)}`, item.snippet);
      const clipped = clip(block, Math.min(budget, 3000));
      blocks.push(clipped);
      budget -= clipped.length;
      included.add(item.path);
      matched.push(item.path);
    }
    let related = 0;
    if (typed && matched.length > 0) {
      const expansion = planRelationExpansion({
        matches: matched,
        edgesOf: (path) => {
          const fm = frontmatterOf(app, path);
          const type = noteType(fm);
          const resolved = type ? typed.resolve(type) : undefined;
          return fm && resolved ? extractEdges(path, fm, resolved) : [];
        },
        resolve: (linkpath, fromPath) => {
          const f = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath);
          return f instanceof TFile && f.extension === "md" ? f.path : null;
        },
        include: (path) => !searchScope || searchScope(path),
        already: included,
        limit: MAX_RELATION_EXPANSION,
      });
      for (const r of expansion) {
        if (budget <= 0) break;
        const f = app.vault.getAbstractFileByPath(r.path);
        if (!(f instanceof TFile)) continue;
        const block = section(`Related (${r.key} of ${r.from}): ${r.path}${label(r.path)}`, await app.vault.cachedRead(f));
        const clipped = clip(block, Math.min(budget, 1500));
        blocks.push(clipped);
        budget -= clipped.length;
        related++;
      }
    }
    const added = matched.length;
    if (added > 0) {
      sources.push(`${added} ${semantic.length ? "semantic" : "search"} match${added > 1 ? "es" : ""}`);
      if (related > 0) sources.push(`${related} related note${related > 1 ? "s" : ""}`);
      // Ask for click-through citations to the source notes (the 1.2 "ask your
      // vault with citations" behavior). Count it against the budget so context
      // never exceeds contextCharBudget; drop it if there's no room left.
      const cited = related > 0 ? '"Search match" or "Related" notes' : '"Search match" notes';
      const citation =
        `When you draw on the ${cited} above, cite each inline as an ` +
        "Obsidian wikilink — [[Note Name]], using the note's file name without the " +
        "folder path or .md extension — so the reader can click through to the source.";
      if (budget >= citation.length) {
        blocks.push(citation);
      }
    }
  }

  if (blocks.length === 0) return { text: "", sources: [] };
  const text = ["<vault_context>", ...blocks, "</vault_context>"].join("\n\n");
  return { text, sources };
}

function frontmatterOf(app: App, path: string): Record<string, unknown> | undefined {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
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
