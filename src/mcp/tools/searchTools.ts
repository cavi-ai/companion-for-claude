import { App, TFile, getAllTags } from "obsidian";
import { vaultTagEntries } from "../../tags/vaultTags";
import type { ToolOutput } from "../protocol";
import type { ToolRecord } from "../toolRecord";
import type { VaultToolsOptions } from "../vaultTools";
import { tokenize } from "../../context/search";
import { fuseKeywordAndSemantic, keywordVaultSearch } from "../../context/hybridSearch";
import { describeFilter, hitMetadata, matchesSearchFilter, parseSearchFilter, type SearchFilter } from "../../context/searchFilter";
import { loadedOntology } from "../../optimize/vaultGlue";
import { assertVaultPath, num, optStr, read, resolveFile, str } from "./context";

export const SEMANTIC_OFF_MESSAGE = "Semantic search is off. Enable it in Companion settings → Semantic search.";

const string = { type: "string" };
const paths = { type: "array", items: string };
const list = (property: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties: { ...extra, [property]: { type: "array", items: item } },
  required: [...required, property],
});
const entry = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

const SEARCH_OUTPUT = list("results", entry({ path: string, snippet: string, metadata: string }, ["path", "snippet"]), { mode: { type: "string", enum: ["keyword", "semantic + keyword"] } });
const RELATED_OUTPUT = list("results", entry({ path: string, similarity: { type: "number" }, type: string }, ["path", "similarity"]), { path: string }, ["path"]);
const RECENT_OUTPUT = list("notes", entry({ path: string, modified: { type: "string", format: "date-time" } }, ["path", "modified"]));
const TAGS_OUTPUT = list("tags", entry({ tag: string, count: { type: "integer" } }, ["tag", "count"]));
const TITLES_OUTPUT = list("notes", entry({ path: string, title: string }, ["path", "title"]));
const BACKLINKS_OUTPUT = { type: "object", properties: { path: string, backlinks: paths }, required: ["path", "backlinks"] };
const OUTGOING_OUTPUT = { type: "object", properties: { path: string, links: paths }, required: ["path", "links"] };
const FRONTMATTER_OUTPUT = { type: "object", properties: { field: string, value: string, notes: paths }, required: ["field", "notes"] };

export class SearchTools {
  constructor(
    private app: App,
    private opts: VaultToolsOptions,
  ) {}

  records(): ToolRecord[] {
    return [
      read({
        name: "vault_search",
        description: "Search the Obsidian vault by meaning and keyword (semantic when enabled, otherwise keyword). Optional filters narrow by frontmatter type, research project, or tag. Returns matching notes with provenance fields and a snippet.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords to search for." },
            limit: { type: "number", description: "Max results (default 8)." },
            type: { type: "string", description: "Only notes whose frontmatter `type` equals this or a declared subtype of it (e.g. 'research-evidence'; 'source' also matches 'article')." },
            project: { type: "string", description: "Only notes whose frontmatter `project` is this project note path (e.g. 'Research/Alpha/Project.md' or 'Alpha/Project')." },
            tag: { type: "string", description: "Only notes with this tag or a nested child of it ('ml' matches #ml and #ml/vision)." },
          },
          required: ["query"],
        },
        outputSchema: SEARCH_OUTPUT,
      }, async (args) => this.search(str(args.query), num(args.limit, 8), parseSearchFilter(args))),
      read({
        name: "related_notes",
        description: "List notes semantically similar to a note, from the local semantic index. Returns vault paths with a similarity score.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault-relative path of the note." },
            limit: { type: "number", description: "Max results (default 8, max 25)." },
          },
          required: ["path"],
        },
        outputSchema: RELATED_OUTPUT,
      }, async (args) => this.related(str(args.path), Math.min(Math.max(Math.trunc(num(args.limit, 8)), 1), 25))),
      read({
        name: "list_recent",
        description: "List the most recently modified notes in the vault.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Max results (default 15)." } },
        },
        outputSchema: RECENT_OUTPUT,
      }, async (args) => this.listRecent(num(args.limit, 15))),
      read({
        name: "vault_tags",
        description: "List existing tags in the vault with usage counts, to reuse consistent tags.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: TAGS_OUTPUT,
      }, async () => this.tags()),
      read({
        name: "list_titles",
        description: "List every Markdown note in the vault as 'path — title', for link/MOC awareness.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: TITLES_OUTPUT,
      }, async () => this.listTitles()),
      read({
        name: "get_backlinks",
        description: "List notes that link TO the given note (incoming wikilinks).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
        outputSchema: BACKLINKS_OUTPUT,
      }, async (args) => this.backlinks(str(args.path))),
      read({
        name: "get_outgoing_links",
        description: "List notes the given note links to (outgoing wikilinks).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
        outputSchema: OUTGOING_OUTPUT,
      }, async (args) => this.outgoingLinks(str(args.path))),
      read({
        name: "frontmatter_query",
        description: "List notes whose YAML frontmatter has a given field, optionally matching a value (scalar equality, or membership when the field is a list like tags).",
        inputSchema: {
          type: "object",
          properties: {
            field: { type: "string", description: "Frontmatter key to match (e.g. 'type', 'status', 'tags')." },
            value: { type: "string", description: "Optional value the field must equal (or contain, for list fields)." },
          },
          required: ["field"],
        },
        outputSchema: FRONTMATTER_OUTPUT,
      }, async (args) => this.frontmatterQuery(str(args.field), optStr(args.value))),
    ];
  }

  private async search(query: string, limit: number, filter: SearchFilter | null): Promise<ToolOutput> {
    const terms = tokenize(query);
    const registry = filter?.type !== undefined ? await loadedOntology(this.opts.ontology?.() ?? null) : null;
    const lineageOf = registry ? (type: string) => registry.resolve(type)?.lineage : undefined;
    const accept = filter
      ? (path: string): boolean => {
          const meta = this.noteMeta(path);
          return meta !== null && matchesSearchFilter(meta.frontmatter, meta.tags, filter, lineageOf);
        }
      : undefined;
    const keyword = await keywordVaultSearch(this.app, query, null, accept);

    // Semantic pass (when enabled + index built); degrades to keyword on failure.
    let semantic: { path: string; text: string }[] = [];
    if (this.opts.semantic) {
      try {
        semantic = await this.opts.semantic(query, limit, accept);
      } catch (e) {
        console.debug("Claude Companion: semantic search failed, falling back to keyword", e);
      }
    }

    if (keyword.length === 0 && semantic.length === 0) {
      if (terms.length === 0 && !this.opts.semantic) return { text: "No searchable terms in query.", structured: { results: [] } };
      return { text: filter ? `No matches for "${query}" (${describeFilter(filter)}).` : `No matches for "${query}".`, structured: { results: [] } };
    }

    const mode = semantic.length ? "semantic + keyword" : "keyword";
    const results = fuseKeywordAndSemantic(keyword, semantic, limit).map((f) => {
      const metadata = hitMetadata(this.noteMeta(f.path)?.frontmatter);
      return { path: f.path, snippet: f.snippet, ...(metadata ? { metadata } : {}) };
    });
    const body = results.map((r) => `## ${r.path}\n${r.metadata ? `${r.metadata}\n` : ""}${r.snippet}`).join("\n\n");
    return { text: `(${mode} search)\n\n${body}`, structured: { mode, results } };
  }

  private noteMeta(path: string): { frontmatter: Record<string, unknown> | undefined; tags: string[] } | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    return { frontmatter: cache?.frontmatter as Record<string, unknown> | undefined, tags: cache ? getAllTags(cache) ?? [] : [] };
  }

  private async related(path: string, limit: number): Promise<ToolOutput> {
    if (!this.opts.related) throw new Error(SEMANTIC_OFF_MESSAGE);
    const file = resolveFile(this.app, assertVaultPath(path));
    const results = (await this.opts.related(file.path, limit)).map((h) => {
      const type = this.noteMeta(h.path)?.frontmatter?.type;
      return { path: h.path, similarity: h.score, ...(typeof type === "string" && type ? { type } : {}) };
    });
    const structured = { path: file.path, results };
    if (results.length === 0) return { text: `No related notes for ${file.path} (index empty or note not indexed).`, structured };
    return { text: results.map((r) => `- ${r.path} (similarity ${r.similarity.toFixed(2)})${r.type ? ` · type: ${r.type}` : ""}`).join("\n"), structured };
  }

  private async listRecent(limit: number): Promise<ToolOutput> {
    const notes = this.app.vault
      .getMarkdownFiles()
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit)
      .map((f) => ({ path: f.path, modified: new Date(f.stat.mtime).toISOString() }));
    if (notes.length === 0) return { text: "Vault has no notes.", structured: { notes } };
    return { text: notes.map((n) => `- ${n.path} (modified ${n.modified.slice(0, 16).replace("T", " ")})`).join("\n"), structured: { notes } };
  }

  private resolvedLinks(): Record<string, Record<string, number>> {
    return (this.app.metadataCache as unknown as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
  }

  private async backlinks(target: string): Promise<ToolOutput> {
    const t = resolveFile(this.app, assertVaultPath(target)).path;
    const links = this.resolvedLinks();
    const sources = Object.keys(links).filter((src) => src !== t && links[src] && t in links[src]);
    sources.sort();
    const structured = { path: t, backlinks: sources };
    if (sources.length === 0) return { text: `No backlinks to ${t}.`, structured };
    return { text: sources.map((s) => `- ${s}`).join("\n"), structured };
  }

  private async outgoingLinks(source: string): Promise<ToolOutput> {
    const s = resolveFile(this.app, assertVaultPath(source)).path;
    const targets = Object.keys(this.resolvedLinks()[s] ?? {}).sort();
    const structured = { path: s, links: targets };
    if (targets.length === 0) return { text: `${s} has no outgoing links.`, structured };
    return { text: targets.map((t) => `- ${t}`).join("\n"), structured };
  }

  private async listTitles(): Promise<ToolOutput> {
    const notes = this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ path: f.path, title: f.basename }));
    if (notes.length === 0) return { text: "Vault has no notes.", structured: { notes } };
    return { text: notes.map((n) => `- ${n.path} — ${n.title}`).join("\n"), structured: { notes } };
  }

  private async tags(): Promise<ToolOutput> {
    const counts = new Map<string, number>();
    for (const entry of vaultTagEntries(this.app)) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
    if (tags.length === 0) return { text: "No tags in the vault yet.", structured: { tags } };
    return { text: tags.map((t) => `- #${t.tag} (${t.count})`).join("\n"), structured: { tags } };
  }

  private async frontmatterQuery(field: string, value: string | undefined): Promise<ToolOutput> {
    const hits: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm || !(field in fm)) continue;
      if (value === undefined) {
        hits.push(file.path);
        continue;
      }
      const v = fm[field];
      if (Array.isArray(v) ? v.map(String).includes(value) : String(v) === value) hits.push(file.path);
    }
    hits.sort();
    const structured = { field, ...(value === undefined ? {} : { value }), notes: hits };
    if (hits.length === 0) return { text: value === undefined ? `No notes have frontmatter field "${field}".` : `No notes where ${field} = "${value}".`, structured };
    return { text: hits.map((p) => `- ${p}`).join("\n"), structured };
  }
}
