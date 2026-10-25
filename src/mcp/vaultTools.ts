import { App, htmlToMarkdown, requestUrl } from "obsidian";
import { resultText, type McpToolDef, type ToolResult } from "./protocol";
import type { OntologyRegistry } from "../ontology/registry";
import type { SemanticSearch } from "../context/hybridSearch";
import { ResearchRepository } from "../research/repository";
import { createResearchRepository } from "../research/repositoryFactory";
import { RESEARCH_TOOL_ALIASES, ResearchTools, type ZoteroResolve } from "../research/tools";
import { advertise, type ToolRecord } from "./toolRecord";
import { captureWebSource, type WebCapture } from "../research/webCapture";
import { requestUrlCaptureIo } from "../web/requestFetch";
import { ZoteroAdapter, type ZoteroLibrary } from "../discovery/adapters/zotero";
import { createObsidianDiscoveryHttp } from "../discovery/adapters/obsidianHttp";
import { assertVaultPath, ensureFolder } from "./tools/context";
import { MemoryTools } from "./tools/memoryTools";
import { NoteTools } from "./tools/noteTools";
import { SearchTools, SEMANTIC_OFF_MESSAGE } from "./tools/searchTools";
import { StructureTools } from "./tools/structureTools";
import { WebTools } from "./tools/webTools";

export { assertVaultPath, SEMANTIC_OFF_MESSAGE };

/** Optional semantic retriever (local embeddings); absent → keyword-only. */
export type { SemanticSearch };

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

const WRITES_OFF_MESSAGE = "Write tools are disabled. Enable 'Allow MCP writes' in Companion for Claude settings.";

/** Discovery order of the vault tools; research read tools follow ontology_get, research write tools come last. */
const TOOL_ORDER = [
  "vault_search",
  "related_notes",
  "note_read",
  "list_recent",
  "vault_tags",
  "list_titles",
  "get_backlinks",
  "get_outgoing_links",
  "frontmatter_query",
  "ontology_get",
  "web_search",
  "web_fetch",
  "memory_record",
  "note_create",
  "note_append",
  "note_update",
  "note_patch",
  "update_frontmatter",
  "note_move",
  "base_create",
  "canvas_create",
  "ontology_propose",
] as const;

/**
 * Vault tools exposed over MCP so Claude Code / Claude Desktop can read,
 * search, and write notes in this vault — the core of the unified bridge.
 *
 * All write tools are gated by the `allowWrites` flag from settings.
 */
export class VaultTools {
  private cached: ToolRecord[] | null = null;

  constructor(
    private app: App,
    private opts: VaultToolsOptions,
  ) {}

  setOptions(opts: VaultToolsOptions): void {
    this.opts = opts;
    this.cached = null;
  }

  /** Every vault and research tool as one record, in discovery order. */
  private records(): ToolRecord[] {
    return (this.cached ??= this.assemble());
  }

  private assemble(): ToolRecord[] {
    const vault = new Map<string, ToolRecord>();
    for (const record of [
      ...new SearchTools(this.app, this.opts).records(),
      ...new NoteTools(this.app, this.opts, () => this.researchRepository()).records(),
      ...new StructureTools(this.app, this.opts).records(),
      ...new WebTools(this.opts).records(),
      ...new MemoryTools(this.app, this.opts).records(),
    ]) vault.set(record.def.name, record);
    const unlisted = [...vault.keys()].filter((name) => !(TOOL_ORDER as readonly string[]).includes(name));
    if (unlisted.length > 0) throw new Error(`Tools missing from the discovery order: ${unlisted.join(", ")}`);
    const research = new ResearchTools(this.researchRepository(), this.webCapture(), this.zoteroResolve(), this.opts.enrichSource).records();
    return [
      ...TOOL_ORDER.flatMap((name) => {
        const record = vault.get(name);
        if (!record) throw new Error(`Tool missing from its group: ${name}`);
        return name === "ontology_get" ? [record, ...research.filter((r) => !r.writes)] : [record];
      }),
      ...research.filter((r) => r.writes),
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
    return resultText(await this.output(name, args));
  }

  /** The full result, with structured data for tools that declare an outputSchema. */
  async output(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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
    return (url) => captureWebSource(url, requestUrlCaptureIo(requestUrl, htmlToMarkdown));
  }

  private researchRepository(): ResearchRepository {
    return createResearchRepository(this.app, {
      ensureFolder: (folder) => ensureFolder(this.app, folder),
      normalizeWritePath: (p) => assertVaultPath(p),
      // research_audit is read-only, but it must fingerprint current PDF bytes
      // or agent-driven audits can silently trust stale evidence. The factory
      // applies its renderer-safe per-asset size bound before allocating.
      includeBinary: true,
    });
  }
}
