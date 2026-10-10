import { App, TFile, normalizePath, getAllTags, requestUrl, parseYaml } from "obsidian";
import { vaultTagEntries, vaultVocabulary } from "../tags/vaultTags";
import { createTagResolver, type ResolvedTag } from "../tags/resolve";
import type { McpToolDef } from "./protocol";
import { tokenize } from "../context/search";
import { fuseKeywordAndSemantic, keywordVaultSearch, type SemanticSearch } from "../context/hybridSearch";
import { describeFilter, hitMetadata, matchesSearchFilter, parseSearchFilter, type SearchFilter } from "../context/searchFilter";
import { ensureVaultFolder, lookupRelationTargetType } from "../vault/vaultFiles";
import { buildFrontmatter, normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import { conform } from "../ontology/conform";
import { describeOntology } from "../ontology/describe";
import { validateProposal } from "../ontology/propose";
import type { OntologyRegistry } from "../ontology/registry";
import { loadedOntology } from "../optimize/vaultGlue";
import { PROPERTY_TYPE_VALUES } from "../ontology/types";
import { replaceSection } from "./edit";
import { readFrontmatter, stripFrontmatter } from "../markdown/frontmatter";
import { DELEGABLE_RESEARCH_KEYS, RESEARCH_ROUTE_HINT, planResearchRouting, runResearchRouting, type ResearchRoutePlan } from "./researchRouting";
import { parseResearchRecord } from "../research/parse";
import type { ResearchRecord } from "../research/types";
import { applyPatch, type PatchTarget } from "./patch";
import { buildCanvas, serializeCanvas, type ProposedCanvasNode, type ProposedCanvasEdge } from "../canvas/jsonCanvas";
import { buildBaseFile, type ProposedBase } from "../bases/baseFile";
import { hasPathTraversal } from "../paths";
import { ResearchRepository } from "../research/repository";
import { createResearchRepository } from "../research/repositoryFactory";
import { RESEARCH_TOOL_ALIASES, ResearchTools, type ZoteroResolve } from "../research/tools";
import { advertise, type ToolRecord } from "./toolRecord";
import { appendRecord, type RecordResult } from "../memory/record";
import { captureWebSource, type WebCapture } from "../research/webCapture";
import { ZoteroAdapter, type ZoteroLibrary } from "../discovery/adapters/zotero";
import { createObsidianDiscoveryHttp } from "../discovery/adapters/obsidianHttp";

/**
 * Normalize a caller-supplied vault path and reject anything that escapes the
 * vault root. `normalizePath` collapses slashes but keeps `..` segments, so
 * writes (`note_create`, `note_append`, `note_move`, folder creation) must be
 * checked explicitly — otherwise `folder: "../../.."` would write outside the
 * vault even though writes are only meant to be vault-scoped.
 */
export function assertVaultPath(p: string): string {
  const norm = normalizePath(p);
  if (hasPathTraversal(norm)) {
    throw new Error(`Path escapes the vault: ${p}`);
  }
  return norm;
}

/** Optional semantic retriever (local embeddings); absent → keyword-only. */
export type { SemanticSearch } from "../context/hybridSearch";

export interface VaultToolsOptions {
  allowWrites: boolean;
  defaultFolder: string;
  /** When set + the index is built, vault_search fuses semantic + keyword. */
  semantic?: SemanticSearch;
  /** Ontology registry accessor; absent/null disables typed creation. */
  ontology?: (() => OntologyRegistry | null) | undefined;
  /** Folder schema notes live in; proposals are written there. */
  ontologyFolder?: (() => string) | undefined;
  /** Zotero library accessor; absent/undefined disables zotero_key resolution on import. */
  zotero?: (() => ZoteroLibrary | undefined) | undefined;
  /** Web tools (read-only, explicit calls only); absent disables each. */
  webSearch?: ((query: string, count: number) => Promise<string>) | undefined;
  webFetch?: ((url: string) => Promise<string>) | undefined;
  /** Semantic neighbours of a note; absent disables related_notes. */
  related?: ((path: string, k: number) => Promise<{ path: string; score: number }[]>) | undefined;
  /** Enrichment pipeline for newly imported research sources; absent imports stay unenriched. */
  enrichSource?: ((path: string) => Promise<void>) | undefined;
  /** Memory write-back; absent disables memory_record. `source`, when set, overrides the caller's. */
  memoryRecord?: {
    enabled: () => boolean;
    path: () => string;
    today: () => string;
    newNote: (body: string) => string;
    source?: string;
  } | undefined;
}

export const MEMORY_RECORD_OFF_MESSAGE = "Memory recording is off in Companion settings.";
const WEB_SEARCH_OFF_MESSAGE = "Web search is disabled. Enable it in Companion settings → Agent.";
const WEB_FETCH_OFF_MESSAGE = "Web fetch is disabled. Enable it in Companion settings → Agent.";
const ONTOLOGY_OFF_MESSAGE = "The ontology is disabled in Companion for Claude settings.";
const WRITES_OFF_MESSAGE = "Write tools are disabled. Enable 'Allow MCP writes' in Companion for Claude settings.";
export const SEMANTIC_OFF_MESSAGE = "Semantic search is off. Enable it in Companion settings → Semantic search.";

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

  /** Every vault and research tool as one record, in discovery order. */
  private records(): ToolRecord[] {
    type Run = (args: Record<string, unknown>) => Promise<string>;
    const read = (def: McpToolDef, run: Run, unavailable?: string): ToolRecord => ({ def, writes: false, run, ...(unavailable ? { unavailable } : {}) });
    const write = (def: McpToolDef, run: Run, unavailable?: string): ToolRecord => ({ def, writes: true, run, ...(unavailable ? { unavailable } : {}) });
    const ontologyOff = this.opts.ontology ? undefined : ONTOLOGY_OFF_MESSAGE;
    const research = new ResearchTools(this.researchRepository(), this.webCapture(), this.zoteroResolve(), this.opts.enrichSource).records();
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
      }, async (args) => this.related(str(args.path), Math.min(Math.max(Math.trunc(num(args.limit, 8)), 1), 25))),
      read({
        name: "note_read",
        description: "Read the full Markdown content of a note by its vault path (e.g. 'Folder/Note.md').",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
      }, async (args) => this.read(str(args.path))),
      read({
        name: "list_recent",
        description: "List the most recently modified notes in the vault.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Max results (default 15)." } },
        },
      }, async (args) => this.listRecent(num(args.limit, 15))),
      read({
        name: "vault_tags",
        description: "List existing tags in the vault with usage counts, to reuse consistent tags.",
        inputSchema: { type: "object", properties: {} },
      }, async () => this.tags()),
      read({
        name: "list_titles",
        description: "List every Markdown note in the vault as 'path — title', for link/MOC awareness.",
        inputSchema: { type: "object", properties: {} },
      }, async () => this.listTitles()),
      read({
        name: "get_backlinks",
        description: "List notes that link TO the given note (incoming wikilinks).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
      }, async (args) => this.backlinks(str(args.path))),
      read({
        name: "get_outgoing_links",
        description: "List notes the given note links to (outgoing wikilinks).",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path to the note." } },
          required: ["path"],
        },
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
      }, async (args) => this.frontmatterQuery(str(args.field), optStr(args.value))),
      read({
        name: "ontology_get",
        description: "Read the vault ontology: every type with its lineage, properties and relations, or one type and its ancestors. Call this before creating typed notes or proposing a type.",
        inputSchema: { type: "object", properties: { type: { type: "string", description: "Optional type name to describe." } } },
      }, async (args) => this.ontologyGet(optStr(args.type)), ontologyOff),
      ...research.filter((record) => !record.writes),
      read({
        name: "web_search",
        description: "Search the public web. Returns numbered results with titles, URLs, and snippets. Use for current events, external facts, or anything the vault can't answer; follow up with web_fetch to read a promising page.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            count: { type: "number", description: "Max results (default 5, cap 10)." },
          },
          required: ["query"],
        },
      }, async (args) => {
        if (!this.opts.webSearch) throw new Error(WEB_SEARCH_OFF_MESSAGE);
        return this.opts.webSearch(str(args.query), Math.min(num(args.count, 5), 10));
      }, this.opts.webSearch ? undefined : WEB_SEARCH_OFF_MESSAGE),
      read({
        name: "web_fetch",
        description: "Read one public web page as clean markdown (readable-content extraction). Use after web_search or on a URL the user gave you.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "The http(s) URL to read." } },
          required: ["url"],
        },
      }, async (args) => {
        if (!this.opts.webFetch) throw new Error(WEB_FETCH_OFF_MESSAGE);
        return this.opts.webFetch(str(args.url));
      }, this.opts.webFetch ? undefined : WEB_FETCH_OFF_MESSAGE),
      write({
        name: "memory_record",
        description: "Record one durable, still-true fact about the user's work (a decision, preference, or project state) in the vault's 'What Claude Knows' memory note. Not for transient chatter. Pass `source` as your agent name (e.g. 'claude-code', 'codex').",
        inputSchema: {
          type: "object",
          properties: {
            fact: { type: "string", description: "The fact, one sentence, at most 500 characters." },
            topic: { type: "string", description: "Optional short topic label (e.g. 'preferences', a project name)." },
            source: { type: "string", description: "Your agent name." },
          },
          required: ["fact"],
        },
      }, async (args) => this.memoryRecord(args), this.opts.memoryRecord?.enabled() ? undefined : MEMORY_RECORD_OFF_MESSAGE),
      write(
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
        async (args) => this.create(str(args.title), str(args.content), optStr(args.folder), strArray(args.tags), optStr(args.type), optObj(args.properties)),
      ),
      write(
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
        async (args) => this.append(str(args.path), str(args.content)),
      ),
      write(
        {
          name: "note_update",
          description: "Replace a note's content in place — the whole body, or one named '## section' if 'section' is given. Overwrites; not append. Companion-managed frontmatter keys cannot be changed this way.",
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
        async (args) => this.update(str(args.path), str(args.content), optStr(args.section)),
      ),
      write(
        {
          name: "note_patch",
          description: "Insert or replace Markdown at one place in a note: a heading's section, a block referenced by ^id, a frontmatter key, or the whole document. 'replace' swaps the target; 'append'/'prepend' insert after/before it. Prefer this over note_update for targeted changes.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative path to the note." },
              target: {
                type: "object",
                description: "Where to patch.",
                properties: {
                  kind: { type: "string", enum: ["heading", "block", "frontmatter", "document"] },
                  heading: { type: "string", description: "Heading text (kind=heading)." },
                  id: { type: "string", description: "Block id, with or without the caret (kind=block)." },
                  key: { type: "string", description: "Frontmatter key (kind=frontmatter)." },
                },
                required: ["kind"],
              },
              op: { type: "string", enum: ["replace", "append", "prepend"] },
              content: { type: "string", description: "Markdown to insert, or the frontmatter value (a list item for append/prepend on a list key)." },
            },
            required: ["path", "target", "op", "content"],
          },
        },
        async (args) => this.patch(str(args.path), args.target, str(args.op), str(args.content)),
      ),
      write(
        {
          name: "update_frontmatter",
          description: "Merge YAML frontmatter into a note. 'tags' are unioned and normalized; other keys are set. Preserves the note body. Companion-managed keys (type, type_name, ontology, source_kind, canonical_id, content_fingerprint, discovery_provenance, zotero_key, arxiv_id, doi, locator_value, source_enriched, session_id) are reserved and rejected.",
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
        async (args) => this.updateFrontmatter(str(args.path), strArray(args.tags), args.fields),
      ),
      write(
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
        async (args) => this.move(str(args.path), str(args.to)),
      ),
      write(
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
                description: "Views: {name, type? (table|cards|list|map|companion-similar), order? (property list like 'file.name'/'note.status'), groupBy? {property, direction}, limit?, filters?, summaries? (property → built-in aggregate like Sum/Average/Median or a custom summaries key)}.",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", enum: ["table", "cards", "list", "map", "companion-similar"] },
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
        async (args) => this.createBase(str(args.title), args, optStr(args.folder)),
      ),
      write(
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
        async (args) => this.createCanvas(str(args.title), args.nodes, args.edges, optStr(args.folder)),
      ),
      write({
          name: "ontology_propose",
          description: "Propose a new note type as a schema note in the ontology folder. Validated against the existing types; rule violations are returned and nothing is written.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Type name, lowercase kebab-case." },
              parent: { type: "string", description: "Parent type (default: entity)." },
              properties: { type: "array", items: { type: "object", properties: { key: { type: "string" }, type: { type: "string", enum: [...PROPERTY_TYPE_VALUES] }, required: { type: "boolean" }, description: { type: "string" } }, required: ["key", "type"] } },
              relations: { type: "array", items: { type: "object", properties: { key: { type: "string" }, targets: { type: "array", items: { type: "string" } }, description: { type: "string" } }, required: ["key", "targets"] } },
            },
            required: ["name"],
          },
        }, async (args) => this.ontologyPropose(args), this.opts.ontology && this.opts.ontologyFolder ? undefined : ONTOLOGY_OFF_MESSAGE),
      ...research.filter((record) => record.writes),
    ];
  }

  /** Offered tools: every available one, write tools only while writes are allowed. */
  definitions(): McpToolDef[] {
    return this.records().filter((record) => !this.unavailableReason(record)).map(advertise);
  }

  /** Why a known tool is not offered right now; undefined when it is offered or the name is unknown. */
  unavailable(name: string): string | undefined {
    const record = this.record(name);
    return record ? this.unavailableReason(record) : undefined;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const record = this.record(name);
    if (!record) throw new Error(name.startsWith("research_") ? `Unknown research tool: ${name}` : `Unknown tool: ${name}`);
    if (record.writes) this.assertWrites();
    return record.run(args);
  }

  private record(name: string): ToolRecord | undefined {
    const canonical = RESEARCH_TOOL_ALIASES[name] ?? name;
    return this.records().find((candidate) => candidate.def.name === canonical);
  }

  private unavailableReason(record: ToolRecord): string | undefined {
    return record.unavailable ?? (record.writes && !this.opts.allowWrites ? WRITES_OFF_MESSAGE : undefined);
  }

  private async memoryRecord(args: Record<string, unknown>): Promise<string> {
    const m = this.opts.memoryRecord;
    if (!m?.enabled()) throw new Error(MEMORY_RECORD_OFF_MESSAGE);
    const path = assertVaultPath(m.path());
    const input = { fact: str(args.fact), topic: optStr(args.topic), source: m.source ?? optStr(args.source), date: m.today() };
    const vault = this.app.vault;
    let result: RecordResult | undefined;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await vault.process(file, (content) => {
          result = appendRecord(content, input, m.newNote);
          return result.kind === "added" ? result.content : content;
        });
        continue;
      }
      const created = appendRecord(null, input, m.newNote);
      if (created.kind !== "added") { result = created; break; }
      try {
        await ensureVaultFolder(this.app, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
        await vault.create(path, created.content);
        result = created;
      } catch {
        // created concurrently: retry through the atomic process path
      }
    }
    if (!result) throw new Error("Could not record the fact; try again.");
    if (result.kind === "error") throw new Error(result.message);
    return result.kind === "duplicate" ? "Already recorded." : "Recorded.";
  }

  private assertWrites(): void {
    if (!this.opts.allowWrites) throw new Error(WRITES_OFF_MESSAGE);
  }

  /** Zotero item-key resolution for research_source_import; undefined when no library is configured. */
  private zoteroResolve(): ZoteroResolve | undefined {
    const library = this.opts.zotero;
    if (!library) return undefined;
    const adapter = new ZoteroAdapter(createObsidianDiscoveryHttp(), library);
    return (key) => adapter.lookup(key);
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
    return createResearchRepository(this.app, {
      ensureFolder: (folder) => this.ensureFolder(folder),
      normalizeWritePath: (p) => assertVaultPath(p),
      // research_audit is read-only, but it must fingerprint current PDF bytes
      // or agent-driven audits can silently trust stale evidence. The factory
      // applies its renderer-safe per-asset size bound before allocating.
      includeBinary: true,
    });
  }

  private async search(query: string, limit: number, filter: SearchFilter | null): Promise<string> {
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
      if (terms.length === 0 && !this.opts.semantic) return "No searchable terms in query.";
      return filter ? `No matches for "${query}" (${describeFilter(filter)}).` : `No matches for "${query}".`;
    }

    const fused = fuseKeywordAndSemantic(keyword, semantic, limit);
    const mode = semantic.length ? "semantic + keyword" : "keyword";
    const body = fused
      .map((f) => {
        const meta = hitMetadata(this.noteMeta(f.path)?.frontmatter);
        return `## ${f.path}\n${meta ? `${meta}\n` : ""}${f.snippet}`;
      })
      .join("\n\n");
    return `(${mode} search)\n\n${body}`;
  }

  private noteMeta(path: string): { frontmatter: Record<string, unknown> | undefined; tags: string[] } | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    return { frontmatter: cache?.frontmatter as Record<string, unknown> | undefined, tags: cache ? getAllTags(cache) ?? [] : [] };
  }

  private async related(path: string, limit: number): Promise<string> {
    if (!this.opts.related) throw new Error(SEMANTIC_OFF_MESSAGE);
    const file = this.resolveFile(assertVaultPath(path));
    const hits = await this.opts.related(file.path, limit);
    if (hits.length === 0) return `No related notes for ${file.path} (index empty or note not indexed).`;
    return hits
      .map((h) => {
        const type = this.noteMeta(h.path)?.frontmatter?.type;
        return `- ${h.path} (similarity ${h.score.toFixed(2)})${typeof type === "string" && type ? ` · type: ${type}` : ""}`;
      })
      .join("\n");
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
    for (const entry of vaultTagEntries(this.app)) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    if (counts.size === 0) return "No tags in the vault yet.";
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `- #${t} (${c})`)
      .join("\n");
  }

  private resolveAgentTags(raw: string[]): { tags: string[]; note: string } {
    if (raw.length === 0) return { tags: [], note: "" };
    const resolve = createTagResolver(vaultVocabulary(this.app));
    const resolved = raw.map(resolve).filter((r): r is ResolvedTag => r !== null);
    const mapped = new Map<string, ResolvedTag>();
    for (const r of resolved) if (r.match === "variant" && !mapped.has(r.input)) mapped.set(r.input, r);
    return {
      tags: [...new Set(resolved.map((r) => r.tag))],
      note: mapped.size > 0 ? `\nTags mapped to existing: ${[...mapped.values()].map((r) => `${r.input} → ${r.tag}`).join(", ")}` : "",
    };
  }

  private async create(
    title: string,
    content: string,
    folder: string | undefined,
    rawTags: string[],
    typeName?: string,
    properties?: Record<string, unknown>,
  ): Promise<string> {
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await this.ensureFolder(dir);
    const { tags, note: mappedNote } = this.resolveAgentTags(rawTags);
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
      const r = conform(merged, resolved, (target) => lookupRelationTargetType(this.app, registry, target));
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
    return `Created note: ${file.path}${conformance}${mappedNote}`;
  }

  private ontologyGet(type: string | undefined): string {
    const registry = this.opts.ontology?.() ?? null;
    return JSON.stringify(describeOntology(registry?.resolved() ?? new Map(), type), null, 2);
  }

  private async ontologyPropose(args: Record<string, unknown>): Promise<string> {
    const registry = this.opts.ontology?.();
    const folder = this.opts.ontologyFolder?.();
    if (!registry || !folder) throw new Error(ONTOLOGY_OFF_MESSAGE);
    const outcome = validateProposal(new Set(registry.resolved().keys()), args);
    if (!outcome.ok) throw new Error(`The proposal was not written:\n- ${outcome.errors.join("\n- ")}`);
    const path = assertVaultPath(`${folder}/${outcome.fileName}`);
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A schema note already exists at ${path}.`);
    await this.ensureFolder(folder);
    const file = await this.app.vault.create(path, outcome.content);
    await registry.load();
    return `Created ${file.path} — type '${outcome.def.name}' extends '${outcome.def.extendsType ?? "entity"}'.`;
  }

  /** Advisory conformance of a typed note after a write; empty when nothing applies. */
  private async conformanceLine(file: TFile): Promise<string> {
    const registry = this.opts.ontology?.() ?? null;
    if (!registry || registry.resolved().size === 0) return "";
    let fm: Record<string, unknown> | null;
    try {
      // The metadata cache updates asynchronously; the file on disk is already written.
      fm = readFrontmatter(await this.app.vault.read(file), (yaml) => parseYaml(yaml) as unknown);
    } catch (e) {
      console.debug("Claude Companion: conformance frontmatter read failed", e);
      return "";
    }
    if (!fm || typeof fm.type !== "string") return "";
    const r = conform(fm, registry.resolve(fm.type), (target) => lookupRelationTargetType(this.app, registry, target));
    if (r.issues.length === 0) return "\nConformance: ok";
    return `\nConformance: ${r.issues.length} issue(s): ${r.issues.map((i) => i.message).join("; ")}`;
  }

  private async append(path: string, content: string): Promise<string> {
    const p = assertVaultPath(path);
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, `\n${content}\n`);
      return `Appended to: ${existing.path}${await this.conformanceLine(existing)}`;
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
      return `Updated section "${section}" in ${file.path}${await this.conformanceLine(file)}`;
    }
    const current = await this.app.vault.cachedRead(file);
    const { keys: changed, newFm } = changedReservedKeys(current, content);
    let plan: ResearchRoutePlan | undefined;
    if (changed.length) {
      const blocked = changed.find((key) => !DELEGABLE_RESEARCH_KEYS.has(key));
      if (blocked) throw managedKeyError(blocked);
      const removed = changed.find((key) => newFm[key] === undefined);
      if (removed) throw managedKeyError(removed);
      const values: Record<string, unknown> = {};
      for (const key of changed) values[key] = newFm[key];
      if (changed.some((key) => key.startsWith("locator_"))) for (const key of ["locator_kind", "locator_value"]) if (newFm[key] !== undefined) values[key] = newFm[key];
      plan = planResearchRouting(await this.researchRecordOf(file), values);
    }
    await this.app.vault.modify(file, content);
    if (plan) await runResearchRouting(this.researchRepository(), plan);
    return `${plan ? `${plan.summaries.join(" ")} ` : ""}Updated ${file.path}${await this.conformanceLine(file)}`;
  }

  private async patch(path: string, target: unknown, op: string, content: string): Promise<string> {
    const file = this.resolveFile(path);
    if (op !== "replace" && op !== "append" && op !== "prepend") throw new Error(`Unknown op: ${op}`);
    const t = (target && typeof target === "object" ? target : {}) as { kind?: unknown; heading?: unknown; id?: unknown; key?: unknown };
    if (t.kind === "frontmatter") {
      const key = str(t.key);
      if (DELEGABLE_RESEARCH_KEYS.has(key)) {
        if (op !== "replace") throw managedKeyError(key);
        const plan = planResearchRouting(await this.researchRecordOf(file), { [key]: content });
        await runResearchRouting(this.researchRepository(), plan);
        return plan.summaries.join(" ");
      }
      assertWritableFrontmatterKey(key);
      if (key === "tags") {
        const { tags, note } = this.resolveAgentTags(splitTagList(content));
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          const existing: unknown[] = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? [fm.tags] : [];
          const present = new Set(existing.map(String));
          const added = tags.filter((tag) => !present.has(tag));
          fm.tags = op === "replace" ? tags : op === "append" ? [...existing, ...added] : [...added, ...existing];
        });
        return `Patched frontmatter "tags" of ${file.path} (${op})${await this.conformanceLine(file)}${note}`;
      }
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (op === "replace") {
          fm[key] = content;
          return;
        }
        const existing = fm[key];
        if (existing !== undefined && !isUnknownArray(existing)) throw new Error(`Frontmatter key "${key}" is not a list; use op "replace".`);
        const list = isUnknownArray(existing) ? [...existing] : [];
        fm[key] = op === "append" ? [...list, content] : [content, ...list];
      });
      return `Patched frontmatter "${key}" of ${file.path} (${op})${await this.conformanceLine(file)}`;
    }
    const patchTarget: PatchTarget | null =
      t.kind === "heading" ? { kind: "heading", heading: str(t.heading) }
      : t.kind === "block" ? { kind: "block", id: str(t.id).replace(/^\^/, "") }
      : t.kind === "document" ? { kind: "document" }
      : null;
    if (!patchTarget) throw new Error(`Unknown target kind: ${String(t.kind)}`);
    const current = await this.app.vault.cachedRead(file);
    await this.app.vault.modify(file, applyPatch(current, { target: patchTarget, op, content }));
    const where = patchTarget.kind === "heading" ? `section "${patchTarget.heading}"` : patchTarget.kind === "block" ? `block ^${patchTarget.id}` : "the document";
    return `Patched ${where} in ${file.path} (${op})${await this.conformanceLine(file)}`;
  }

  private async updateFrontmatter(path: string, rawTags: string[], fields: unknown): Promise<string> {
    const file = this.resolveFile(path);
    const scalars: Record<string, string | number | boolean> = {};
    const fieldTags: string[] = [];
    if (fields && typeof fields === "object") {
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        if (k === "tags") {
          if (typeof v === "string") fieldTags.push(...splitTagList(v));
          else if (isUnknownArray(v)) fieldTags.push(...v.filter((i): i is string => typeof i === "string"));
        } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") scalars[k] = v;
      }
    }
    const { tags, note: mappedNote } = this.resolveAgentTags([...rawTags, ...fieldTags]);
    const delegated: Record<string, unknown> = {};
    for (const k of Object.keys(scalars)) {
      if (DELEGABLE_RESEARCH_KEYS.has(k)) { delegated[k] = scalars[k]; delete scalars[k]; }
      else assertWritableFrontmatterKey(k);
    }
    const plan = Object.keys(delegated).length ? planResearchRouting(await this.researchRecordOf(file), delegated) : undefined;
    if (plan) {
      await runResearchRouting(this.researchRepository(), plan);
      if (!tags.length && !Object.keys(scalars).length) return plan.summaries.join(" ");
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
    return `${plan ? `${plan.summaries.join(" ")} ` : ""}Updated frontmatter of ${file.path}${await this.conformanceLine(file)}${mappedNote}`;
  }

  private async researchRecordOf(file: TFile): Promise<ResearchRecord | undefined> {
    const content = await this.app.vault.cachedRead(file);
    const frontmatter = readFrontmatter(content, (yaml) => parseYaml(yaml) as unknown);
    if (!frontmatter) return undefined;
    return parseResearchRecord({ path: file.path, frontmatter, body: stripFrontmatter(content) }).record;
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
    await ensureVaultFolder(this.app, assertVaultPath(folder));
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
function splitTagList(content: string): string[] {
  return content.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Array.isArray narrows to any[]; this keeps the narrowed elements unknown. */
function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
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

/**
 * Machine-owned frontmatter keys the generic frontmatter writers
 * (update_frontmatter, note_patch kind=frontmatter) may never set. These encode
 * plugin identity/state — a research record's type, a memory digest's
 * session_id, an inbox clip's enrichment flag, a source's content fingerprint —
 * so an agent scribbling over them silently breaks research parsing, session
 * dedup, and triage. Dedicated flows own these keys.
 */
const RESERVED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  // identity / schema
  "type",
  "type_name",
  "ontology",
  // research records (research/parse.ts, research/render.ts): the record type
  // gate plus the relations and locator/state fields the parser validates.
  "project",
  "source",
  "source_kind",
  "canonical_id",
  "source_fingerprint",
  "content_fingerprint",
  "discovery_provenance",
  "zotero_key",
  "arxiv_id",
  "doi",
  "locator_kind",
  "locator_value",
  "review_state",
  "document_kind",
  // capture / enrichment state
  "source_enriched",
  // memory digests (memory/note.ts)
  "session_id",
  "claude-session",
]);

const RESEARCH_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "project", "source", "source_kind", "canonical_id", "source_fingerprint", "content_fingerprint", "discovery_provenance",
  "zotero_key", "arxiv_id", "doi", "locator_kind", "locator_value", "review_state", "document_kind",
]);

function managedKeyError(key: string): Error {
  return new Error(RESEARCH_RESERVED_KEYS.has(key)
    ? `Frontmatter key "${key}" is managed by Companion. ${RESEARCH_ROUTE_HINT}`
    : `Frontmatter key "${key}" is managed by Companion and cannot be set through this tool.`);
}

/** Guard the generic frontmatter writers against clobbering machine-owned keys. */
function assertWritableFrontmatterKey(key: string): void {
  if (RESERVED_FRONTMATTER_KEYS.has(key)) throw managedKeyError(key);
}
/** Reserved keys whose value differs between two note contents. */
function changedReservedKeys(oldContent: string, newContent: string): { keys: string[]; newFm: Record<string, unknown> } {
  const oldFm = readFrontmatter(oldContent, (yaml) => parseYaml(yaml) as unknown) ?? {};
  const newFm = readFrontmatter(newContent, (yaml) => parseYaml(yaml) as unknown) ?? {};
  return { keys: [...RESERVED_FRONTMATTER_KEYS].filter((key) => JSON.stringify(oldFm[key]) !== JSON.stringify(newFm[key])), newFm };
}
/** Narrow a conformance-fixed record to buildFrontmatter's value types; anything else is dropped. */
function toFrontmatterData(record: Record<string, unknown>): FrontmatterData {
  const out: FrontmatterData = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((x): x is string => typeof x === "string")) out[key] = value;
  }
  return out;
}
