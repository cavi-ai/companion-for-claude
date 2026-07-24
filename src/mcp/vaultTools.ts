import { App, TFile, normalizePath, getAllTags, parseYaml, requestUrl } from "obsidian";
import type { McpToolDef } from "./protocol";
import { scoreContent, snippetAround, tokenize } from "../context/search";
import { reciprocalRankFusion } from "../semantic/similarity";
import { buildFrontmatter, normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import { conform } from "../ontology/conform";
import type { OntologyRegistry } from "../ontology/registry";
import type { ResolvedType } from "../ontology/types";
import { replaceSection } from "./edit";
import { buildCanvas, serializeCanvas, type ProposedCanvasNode, type ProposedCanvasEdge } from "../canvas/jsonCanvas";
import { buildBaseFile, type ProposedBase } from "../bases/baseFile";
import { ResearchRepository } from "../research/repository";
import { RESEARCH_WRITE_TOOLS, ResearchTools } from "../research/tools";
import { captureWebSource, type WebCapture } from "../research/webCapture";

/**
 * Normalize a caller-supplied vault path and reject anything that escapes the
 * vault root. `normalizePath` collapses slashes but keeps `..` segments, so
 * writes (`note_create`, `note_append`, `note_move`, folder creation) must be
 * checked explicitly — otherwise `folder: "../../.."` would write outside the
 * vault even though writes are only meant to be vault-scoped.
 */
export function assertVaultPath(p: string): string {
  const norm = normalizePath(p);
  if (norm.startsWith("/") || norm.split("/").some((seg) => seg === "..")) {
    throw new Error(`Path escapes the vault: ${p}`);
  }
  return norm;
}

/** Optional semantic retriever (local embeddings); absent → keyword-only. */
export type SemanticSearch = (query: string, k: number) => Promise<{ path: string; text: string }[]>;

export interface VaultToolsOptions {
  allowWrites: boolean;
  defaultFolder: string;
  /** When set + the index is built, vault_search fuses semantic + keyword. */
  semantic?: SemanticSearch;
  /** Ontology registry accessor; absent/null disables typed creation. */
  ontology?: (() => OntologyRegistry | null) | undefined;
}

/**
 * Vault tools exposed over MCP so Claude Code / Claude Desktop can read,
 * search, and write notes in this vault — the core of the unified bridge.
 *
 * All write tools are gated by the `allowWrites` flag from settings.
 */
export class VaultTools {
  constructor(
    private app: App,
    private opts: VaultToolsOptions,
  ) {}

  setOptions(opts: VaultToolsOptions): void {
    this.opts = opts;
  }

  definitions(): McpToolDef[] {
    const defs: McpToolDef[] = [
      {
        name: "vault_search",
        description: "Search the Obsidian vault by meaning and keyword (semantic when enabled, otherwise keyword). Returns matching notes with a snippet.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords to search for." },
            limit: { type: "number", description: "Max results (default 8)." },
          },
          required: ["query"],
        },
      },
      {
        name: "note_read",
        description: "Read the full Markdown content of a note by its vault path (e.g. 'Folder/Note.md').",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
      },
      {
        name: "list_recent",
        description: "List the most recently modified notes in the vault.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Max results (default 15)." } },
        },
      },
      {
        name: "vault_tags",
        description: "List existing tags in the vault with usage counts, to reuse consistent tags.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_titles",
        description: "List every Markdown note in the vault as 'path — title', for link/MOC awareness.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_backlinks",
        description: "List notes that link TO the given note (incoming wikilinks).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
      },
      {
        name: "get_outgoing_links",
        description: "List notes the given note links to (outgoing wikilinks).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
      },
      {
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
      },
    ];

    const researchDefinitions = new ResearchTools(this.researchRepository()).definitions();
    defs.push(...researchDefinitions.filter(({ name }) => !RESEARCH_WRITE_TOOLS.has(name)));

    if (this.opts.allowWrites) {
      defs.push(
        {
          name: "note_create",
          description: "Create a new Markdown note. Adds YAML frontmatter (title, tags, source) for correct indexing.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Note title (also used for the filename)." },
              content: { type: "string", description: "Markdown body." },
              folder: { type: "string", description: "Target folder (defaults to the configured folder)." },
              tags: { type: "array", items: { type: "string" }, description: "Tags to apply." },
              ...((this.opts.ontology?.()?.resolved().size ?? 0) > 0
                ? {
                    type: { type: "string", description: "Ontology type for this note (e.g. person, project, concept; unknown types are reported back with the available list)." },
                    properties: { type: "object", description: "Type-specific frontmatter properties and relation fields (relations are lists of \"[[wikilink]]\" strings)." },
                  }
                : {}),
            },
            required: ["title", "content"],
          },
        },
        {
          name: "note_append",
          description: "Append Markdown text to an existing note (creates it if missing).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              content: { type: "string", description: "Markdown to append." },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "note_update",
          description: "Replace a note's content in place — the whole body, or one named '## section' if 'section' is given. Overwrites; not append.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              content: { type: "string", description: "New content for the note (or for the section)." },
              section: { type: "string", description: "Optional heading text; replace only that section's body." },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "update_frontmatter",
          description: "Merge YAML frontmatter into a note. 'tags' are unioned and normalized; other keys are set. Preserves the note body.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              tags: { type: "array", items: { type: "string" }, description: "Tags to add (unioned with existing)." },
              fields: { type: "object", description: "Other scalar frontmatter fields to set (e.g. {type:'note'})." },
            },
            required: ["path"],
          },
        },
        {
          name: "note_move",
          description: "Move or rename a note to a new vault path. Backlinks to it are rewritten automatically. Provide the full destination path (including filename).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Current vault-relative path of the note." },
              to: { type: "string", description: "Destination vault-relative path (folder and filename)." },
            },
            required: ["path", "to"],
          },
        },
        {
          name: "base_create",
          description:
            "Create an Obsidian Base (.base) — a database view over notes, driven by their frontmatter properties. Use frontmatter_query/vault_tags first to discover real property names. Filters accept a statement like 'file.hasTag(\"book\")', an array of statements (AND-ed), or a recursive {and|or|not: [...]} group. Great for reading trackers, project dashboards, and review queues.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Base title (also the filename)." },
              filters: { description: "Global filters: a statement string, an array of statements (AND-ed), or one recursive {and|or|not: [...]} group." },
              views: {
                type: "array",
                description: "Views: {name, type? (table|cards|list|map), order? (property list like 'file.name'/'note.status'), groupBy? {property, direction}, limit?, filters?, summaries? (property → built-in aggregate like Sum/Average/Median or a custom summaries key)}.",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", enum: ["table", "cards", "list", "map"] },
                    order: { type: "array", items: { type: "string" } },
                    groupBy: {
                      type: "object",
                      properties: { property: { type: "string" }, direction: { type: "string", enum: ["ASC", "DESC"] } },
                      required: ["property"],
                    },
                    limit: { type: "number" },
                    filters: { description: "View filters: a statement string, an array of statements (AND-ed), or one recursive {and|or|not: [...]} group." },
                    summaries: { type: "object", description: "property id → summary name (built-ins: Average, Min, Max, Sum, Range, Median, Stddev, Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique)." },
                  },
                  required: ["name"],
                },
              },
              formulas: { type: "object", description: "formula name → expression (e.g. {ppu: '(price / age).toFixed(2)'})." },
              properties: { type: "object", description: "property id → display name (e.g. {status: 'Status'})." },
              summaries: { type: "object", description: "Custom summary name → expression (e.g. {p90: 'values.percentile(90)'})." },
              folder: { type: "string", description: "Target folder (defaults to the configured folder)." },
            },
            required: ["title", "views"],
          },
        },
        {
          name: "canvas_create",
          description:
            "Create an Obsidian Canvas (.canvas) — a visual mind map / board of nodes and edges. Nodes: text (idea cards), file (embed a vault note by path), link (url), or group (labeled container; put nodes inside via their group field). Omit x/y to auto-layout left-to-right by edge depth; grouped nodes grid inside their auto-sized group. Use for mind maps, project boards, and argument maps wired to real notes.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Canvas title (also the filename)." },
              nodes: {
                type: "array",
                description: "Nodes: {id?, text?} for idea cards, {id?, file?} to embed a note, {id?, url?} for links, {id, type: 'group', label?} for containers. Set group: <groupId> on a node to place it inside that group. Optional x/y/width/height/color.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: { type: "string", enum: ["text", "file", "link", "group"] },
                    text: { type: "string" },
                    file: { type: "string" },
                    url: { type: "string" },
                    label: { type: "string", description: "Group label (group nodes only)." },
                    group: { type: "string", description: "Id of the group node this node belongs to." },
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                    color: { type: "string" },
                  },
                },
              },
              edges: {
                type: "array",
                description: "Directed edges between node ids, with optional labels.",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["from", "to"],
                },
              },
              folder: { type: "string", description: "Target folder (defaults to the configured folder)." },
            },
            required: ["title", "nodes"],
          },
        },
      );
      defs.push(...researchDefinitions.filter(({ name }) => RESEARCH_WRITE_TOOLS.has(name)));
    }
    return defs;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name.startsWith("research_")) {
      if (RESEARCH_WRITE_TOOLS.has(name)) this.assertWrites();
      return new ResearchTools(this.researchRepository(), this.webCapture()).call(name, args);
    }
    switch (name) {
      case "vault_search":
        return this.search(str(args.query), num(args.limit, 8));
      case "note_read":
        return this.read(str(args.path));
      case "list_recent":
        return this.listRecent(num(args.limit, 15));
      case "vault_tags":
        return this.tags();
      case "list_titles":
        return this.listTitles();
      case "get_backlinks":
        return this.backlinks(str(args.path));
      case "get_outgoing_links":
        return this.outgoingLinks(str(args.path));
      case "frontmatter_query":
        return this.frontmatterQuery(str(args.field), optStr(args.value));
      case "note_create":
        this.assertWrites();
        return this.create(str(args.title), str(args.content), optStr(args.folder), strArray(args.tags), optStr(args.type), optObj(args.properties));
      case "note_append":
        this.assertWrites();
        return this.append(str(args.path), str(args.content));
      case "note_update":
        this.assertWrites();
        return this.update(str(args.path), str(args.content), optStr(args.section));
      case "update_frontmatter":
        this.assertWrites();
        return this.updateFrontmatter(str(args.path), strArray(args.tags), args.fields);
      case "note_move":
        this.assertWrites();
        return this.move(str(args.path), str(args.to));
      case "canvas_create":
        this.assertWrites();
        return this.createCanvas(str(args.title), args.nodes, args.edges, optStr(args.folder));
      case "base_create":
        this.assertWrites();
        return this.createBase(str(args.title), args, optStr(args.folder));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private assertWrites(): void {
    if (!this.opts.allowWrites) throw new Error("Write tools are disabled. Enable 'Allow MCP writes' in Companion for Claude settings.");
  }

  /** Readable-markdown web capture for research_source_import (renderer only). */
  private webCapture(): WebCapture | undefined {
    if (typeof DOMParser === "undefined") return undefined;
    return (url) => captureWebSource(url, {
      fetchHtml: async (target) => {
        const response = await requestUrl({ url: target, method: "GET", throw: false });
        if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
        return response.text;
      },
      parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
    });
  }

  private researchRepository(): ResearchRepository {
    const readNotes = async (files: TFile[]) => Promise.all(files.map(async (file) => {
      const content = await this.app.vault.cachedRead(file);
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
      const frontmatter = cached ?? (match ? parseYaml(match[1] ?? "") as Record<string, unknown> : undefined);
      return { path: file.path, ...(frontmatter ? { frontmatter } : {}), body };
    }));
    return new ResearchRepository({
      listMarkdown: async () => readNotes(this.app.vault.getMarkdownFiles()),
      listProjectMarkdown: async (projectPath) => {
        const folder = projectPath.slice(0, -"/Project.md".length);
        const canonicalPrefixes = ["Sources", "Evidence", "Claims", "Questions", "Documents"].map((name) => `${folder}/${name}/`);
        const candidates = this.app.vault.getMarkdownFiles().filter((file) => {
          return file.path === projectPath || canonicalPrefixes.some((prefix) => file.path.startsWith(prefix));
        });
        return readNotes(candidates);
      },
      createWithParents: async (path, content) => {
        const safe = assertVaultPath(path);
        if (this.app.vault.getAbstractFileByPath(safe)) throw new Error(`File already exists: ${safe}`);
        await this.ensureFolder(safe.slice(0, safe.lastIndexOf("/")));
        await this.app.vault.create(safe, content);
      },
      updateFrontmatter: async (path, mutator) => {
        const file = this.resolveFile(path);
        await this.app.fileManager.processFrontMatter(file, mutator);
      },
      updateText: async (path, updater) => {
        const file = this.resolveFile(path);
        await this.app.vault.process(file, updater);
      },
    });
  }

  private async search(query: string, limit: number): Promise<string> {
    // Keyword pass.
    const terms = tokenize(query);
    const keyword: Array<{ path: string; score: number; snippet: string }> = [];
    if (terms.length > 0) {
      for (const file of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(file);
        const lowerTags = cache ? (getAllTags(cache) ?? []).join(" ").toLowerCase() : "";
        const content = await this.app.vault.cachedRead(file);
        const { score, firstIdx } = scoreContent(terms, file.path.toLowerCase(), lowerTags, content);
        if (score > 0) keyword.push({ path: file.path, score, snippet: snippetAround(content, firstIdx) });
      }
      keyword.sort((a, b) => b.score - a.score);
    }

    // Semantic pass (when enabled + index built); degrades to keyword on failure.
    let semantic: { path: string; text: string }[] = [];
    if (this.opts.semantic) {
      try {
        semantic = await this.opts.semantic(query, limit);
      } catch {
        /* Ollama down / no index → keyword only */
      }
    }

    if (keyword.length === 0 && semantic.length === 0) {
      return terms.length === 0 && !this.opts.semantic ? "No searchable terms in query." : `No matches for "${query}".`;
    }

    // Fuse by path (reciprocal rank fusion); keep the best snippet per note.
    const snippet = new Map<string, string>();
    for (const k of keyword) if (!snippet.has(k.path)) snippet.set(k.path, k.snippet);
    for (const doc of semantic) if (!snippet.has(doc.path)) snippet.set(doc.path, doc.text);
    const fused = reciprocalRankFusion([
      keyword.map((h) => ({ id: h.path, score: h.score })),
      semantic.map((doc) => ({ id: doc.path, score: 1 })),
    ]).slice(0, limit);

    const mode = semantic.length ? "semantic + keyword" : "keyword";
    const body = fused.map((f) => `## ${f.id}\n${snippet.get(f.id) ?? ""}`).join("\n\n");
    return `(${mode} search)\n\n${body}`;
  }

  private async read(path: string): Promise<string> {
    const file = this.resolveFile(path);
    return this.app.vault.cachedRead(file);
  }

  private async listRecent(limit: number): Promise<string> {
    const files = this.app.vault
      .getMarkdownFiles()
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, limit);
    if (files.length === 0) return "Vault has no notes.";
    return files.map((f) => `- ${f.path} (modified ${new Date(f.stat.mtime).toISOString().slice(0, 16).replace("T", " ")})`).join("\n");
  }

  private resolvedLinks(): Record<string, Record<string, number>> {
    return (this.app.metadataCache as unknown as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
  }

  private async backlinks(target: string): Promise<string> {
    const t = normalizePath(target);
    const links = this.resolvedLinks();
    const sources = Object.keys(links).filter((src) => src !== t && links[src] && t in links[src]);
    sources.sort();
    if (sources.length === 0) return `No backlinks to ${t}.`;
    return sources.map((s) => `- ${s}`).join("\n");
  }

  private async outgoingLinks(source: string): Promise<string> {
    const s = normalizePath(source);
    const targets = Object.keys(this.resolvedLinks()[s] ?? {}).sort();
    if (targets.length === 0) return `${s} has no outgoing links.`;
    return targets.map((t) => `- ${t}`).join("\n");
  }

  private async listTitles(): Promise<string> {
    const files = this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) return "Vault has no notes.";
    return files.map((f) => `- ${f.path} — ${f.basename}`).join("\n");
  }

  private async tags(): Promise<string> {
    const counts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      for (const t of getAllTags(cache) ?? []) {
        const tag = t.replace(/^#/, "");
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return "No tags in the vault yet.";
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `- #${t} (${c})`)
      .join("\n");
  }

  private async create(
    title: string,
    content: string,
    folder: string | undefined,
    tags: string[],
    typeName?: string,
    properties?: Record<string, unknown>,
  ): Promise<string> {
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await this.ensureFolder(dir);
    const base: FrontmatterData = {
      title,
      created: new Date().toISOString().slice(0, 10),
      source: "claude-mcp",
      tags: normalizeTags(["claude", ...tags]),
    };
    let data: FrontmatterData = base;
    let conformance = "";
    const registry = this.opts.ontology?.() ?? null;
    // An enabled-but-empty registry (never seeded) behaves like no ontology.
    if (registry && registry.resolved().size > 0 && typeName) {
      const resolved = registry.resolve(typeName);
      // Base keys + the validated type always win over model-supplied properties.
      const safeProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(properties ?? {})) if (!PROTECTED_KEYS.has(k)) safeProps[k] = v;
      const merged: Record<string, unknown> = { ...base, type: typeName, ...safeProps };
      const r = conform(merged, resolved, (target) => this.lookupTargetType(registry, target));
      // Unknown type: fall back to the untyped legacy frontmatter — advisory, never blocking.
      data = resolved ? toFrontmatterData(r.fixed) : base;
      if (r.issues.length > 0) {
        const messages = r.issues.map((i) =>
          i.kind === "unknown-type" ? `${i.message} — available: ${[...registry.resolved().keys()].join(", ")}` : i.message,
        );
        conformance = `\nConformance: ${messages.join("; ")}`;
      }
    }
    const body = `${buildFrontmatter(data)}\n\n# ${title}\n\n${content}\n`;
    const path = await this.uniquePath(dir, title);
    const file = await this.app.vault.create(path, body);
    return `Created note: ${file.path}${conformance}`;
  }

  /** Resolve a relation target (basename/path as written) to that note's ResolvedType. */
  private lookupTargetType(registry: OntologyRegistry, target: string): ResolvedType | undefined {
    // Real Obsidian resolves linkpaths via metadataCache; the test fake doesn't
    // implement that method, so fall back to a basename/path scan.
    const cache: { getFirstLinkpathDest?: (linkpath: string, sourcePath: string) => TFile | null } = this.app.metadataCache;
    const file =
      typeof cache.getFirstLinkpathDest === "function"
        ? cache.getFirstLinkpathDest(target, "")
        : (this.app.vault.getMarkdownFiles().find((f) => f.basename === target || f.path === normalizePath(target)) ?? null);
    if (!file) return undefined;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const t = fm?.type;
    return typeof t === "string" ? registry.resolve(t) : undefined;
  }

  private async append(path: string, content: string): Promise<string> {
    const p = assertVaultPath(path);
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, `\n${content}\n`);
      return `Appended to: ${existing.path}`;
    }
    const file = await this.app.vault.create(p, `${content}\n`);
    return `Created and wrote: ${file.path}`;
  }

  private async update(path: string, content: string, section: string | undefined): Promise<string> {
    const file = this.resolveFile(path);
    if (section) {
      const current = await this.app.vault.cachedRead(file);
      const next = replaceSection(current, section, content);
      await this.app.vault.modify(file, next);
      return `Updated section "${section}" in ${file.path}`;
    }
    await this.app.vault.modify(file, content);
    return `Updated ${file.path}`;
  }

  private async updateFrontmatter(path: string, tags: string[], fields: unknown): Promise<string> {
    const file = this.resolveFile(path);
    const scalars: Record<string, string | number | boolean> = {};
    if (fields && typeof fields === "object") {
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") scalars[k] = v;
      }
    }
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (tags.length) {
        const existing = Array.isArray(fm.tags)
          ? (fm.tags as unknown[]).map(String)
          : typeof fm.tags === "string"
            ? [fm.tags]
            : [];
        fm.tags = normalizeTags([...existing, ...tags]);
      }
      for (const [k, v] of Object.entries(scalars)) fm[k] = v;
    });
    return `Updated frontmatter of ${file.path}`;
  }

  private async frontmatterQuery(field: string, value: string | undefined): Promise<string> {
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
    if (hits.length === 0) return value === undefined ? `No notes have frontmatter field "${field}".` : `No notes where ${field} = "${value}".`;
    return hits.map((p) => `- ${p}`).join("\n");
  }

  private async createBase(title: string, args: Record<string, unknown>, folder: string | undefined): Promise<string> {
    const yaml = buildBaseFile({
      ...(args.filters !== undefined ? { filters: args.filters as Exclude<ProposedBase["filters"], undefined> } : {}),
      views: Array.isArray(args.views) ? (args.views as ProposedBase["views"]) : [],
      ...(args.formulas && typeof args.formulas === "object" ? { formulas: args.formulas as Record<string, string> } : {}),
      ...(args.properties && typeof args.properties === "object" ? { properties: args.properties as Record<string, string> } : {}),
      ...(args.summaries && typeof args.summaries === "object" ? { summaries: args.summaries as Record<string, string> } : {}),
    });
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await this.ensureFolder(dir);
    const path = await this.uniquePath(dir, title, ".base");
    const file = await this.app.vault.create(path, yaml);
    return `Created base: ${file.path}`;
  }

  private async createCanvas(title: string, nodes: unknown, edges: unknown, folder: string | undefined): Promise<string> {
    const data = buildCanvas(
      Array.isArray(nodes) ? (nodes as ProposedCanvasNode[]) : [],
      Array.isArray(edges) ? (edges as ProposedCanvasEdge[]) : [],
    );
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await this.ensureFolder(dir);
    const path = await this.uniquePath(dir, title, ".canvas");
    const file = await this.app.vault.create(path, serializeCanvas(data));
    return `Created canvas: ${file.path} (${data.nodes.length} nodes, ${data.edges.length} edges)`;
  }

  private async move(path: string, to: string): Promise<string> {
    const file = this.resolveFile(path);
    const dest = assertVaultPath(to);
    await this.app.fileManager.renameFile(file, dest);
    return `Moved ${path} → ${dest} (backlinks updated)`;
  }

  // ---- helpers ----

  private resolveFile(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (f instanceof TFile) return f;
    throw new Error(`Note not found: ${path}`);
  }

  private async ensureFolder(folder: string): Promise<void> {
    const p = assertVaultPath(folder);
    if (p === "" || p === "/" || this.app.vault.getAbstractFileByPath(p)) return;
    let cur = "";
    for (const part of p.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          /* race */
        }
      }
    }
  }

  private async uniquePath(folder: string, title: string, ext = ".md"): Promise<string> {
    const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
    let path = normalizePath(folder ? `${folder}/${safe}${ext}` : `${safe}${ext}`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(folder ? `${folder}/${safe} ${i}${ext}` : `${safe} ${i}${ext}`);
      i++;
    }
    return path;
  }
}

function str(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new Error("Expected a non-empty string argument.");
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function optObj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
/** note_create base-frontmatter keys the model's `properties` may never overwrite. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(["type", "title", "created", "source", "tags"]);
/** Narrow a conformance-fixed record to buildFrontmatter's value types; anything else is dropped. */
function toFrontmatterData(record: Record<string, unknown>): FrontmatterData {
  const out: FrontmatterData = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((x): x is string => typeof x === "string")) out[key] = value;
  }
  return out;
}
