// Builds the VaultTools options shared by the MCP bridge and the in-chat agent.

import { requestUrl, TFile } from "obsidian";
import { createObsidianDiscoveryHttp } from "../discovery/adapters/obsidianHttp";
import type { ZoteroLibrary } from "../discovery/adapters/zotero";
import type ClaudeCompanionPlugin from "../main";
import { SEMANTIC_OFF_MESSAGE, type VaultToolsOptions } from "../mcp/vaultTools";
import { renderMemoryNote } from "../memory/consolidate";
import { webFetch as webFetchPage } from "../web/fetch";
import { braveSearch, duckDuckGoSearch, formatSearchResults } from "../web/search";

export type VaultToolsHost = Pick<ClaudeCompanionPlugin, "app" | "enrichment" | "memoryNotePath" | "ontology" | "semantic" | "settings">;

export function memoryRecordDeps(host: VaultToolsHost, source?: string): NonNullable<VaultToolsOptions["memoryRecord"]> {
  return {
    enabled: () => host.settings.memoryRecordEnabled,
    path: () => host.memoryNotePath(),
    today: () => new Date().toISOString().slice(0, 10),
    newNote: (body) => renderMemoryNote(body, { updated: new Date().toISOString().slice(0, 10), digestCount: 0, baseTags: [...host.settings.memoryBaseTags, "memory"] }),
    ...(source ? { source } : {}),
  };
}

/** Configured Zotero library for zotero_key import resolution; undefined until a user id is set. */
export function zoteroLibrary(host: Pick<VaultToolsHost, "settings">): ZoteroLibrary | undefined {
  const userId = host.settings.zoteroUserId.trim();
  if (!userId) return undefined;
  const apiKey = host.settings.zoteroApiKey.trim();
  return { userId, ...(apiKey ? { apiKey } : {}) };
}

/** Run the source-enrichment pipeline on a research source the agent just imported. */
export async function enrichImportedResearchSource(host: Pick<VaultToolsHost, "app" | "enrichment">, path: string): Promise<void> {
  const file = host.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const outcome = await host.enrichment().enrichResearchSource({
    path: file.path,
    basename: file.basename,
    extension: file.extension,
    stat: { size: file.stat.size },
  });
  if (outcome.status === "failed") throw outcome.error;
}

/**
 * The agent's web tools, built from settings on every call. Each fires only
 * on an explicit model tool call — nothing searches or fetches in the
 * background. DOMParser-less environments (headless tests) get no tools.
 */
export function webToolImpls(host: Pick<VaultToolsHost, "settings">): Pick<VaultToolsOptions, "webSearch" | "webFetch"> {
  const s = host.settings;
  const out: { webSearch?: (query: string, count: number) => Promise<string>; webFetch?: (url: string) => Promise<string> } = {};
  if (s.webSearchEnabled) {
    out.webSearch = async (query, count) => {
      if (s.webSearchEngine === "brave") {
        if (!s.braveSearchApiKey.trim()) {
          throw new Error("Brave Search needs an API key — add it in Companion settings → Agent, or switch to DuckDuckGo.");
        }
        return formatSearchResults(query, await braveSearch(createObsidianDiscoveryHttp(), s.braveSearchApiKey, query, count));
      }
      if (typeof DOMParser === "undefined") throw new Error("Web search is unavailable in this environment.");
      return formatSearchResults(
        query,
        await duckDuckGoSearch(
          {
            fetchHtml: async (url) => {
              const response = await requestUrl({ url, method: "GET", throw: false });
              if (response.status >= 400) throw new Error(`Search failed (${response.status}).`);
              return response.text;
            },
            parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
          },
          query,
          count,
        ),
      );
    };
  }
  if (s.webFetchEnabled && typeof DOMParser !== "undefined") {
    out.webFetch = (url) =>
      webFetchPage(url, {
        fetchHtml: async (target) => {
          const response = await requestUrl({ url: target, method: "GET", throw: false });
          if (response.status >= 400) throw new Error(`Fetch failed with status ${response.status}`);
          return response.text;
        },
        parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
      });
  }
  return out;
}

/** Vault tool options for the MCP bridge and the in-chat agent; they differ only in the write gate and memory source. */
export function vaultToolOptions(host: VaultToolsHost, allowWrites: boolean, memorySource?: string): VaultToolsOptions {
  return {
    allowWrites,
    defaultFolder: host.settings.mcpWriteFolder,
    semantic: (q: string, k: number, accept?: (path: string) => boolean) => host.semantic().semanticSearch(q, k, accept),
    related: async (p: string, k: number) => {
      if (!host.settings.semanticEnabled) throw new Error(SEMANTIC_OFF_MESSAGE);
      return host.semantic().relatedForTools(p, k);
    },
    ontology: () => host.ontology(),
    ontologyFolder: () => host.settings.ontologyFolder,
    zotero: () => zoteroLibrary(host),
    enrichSource: (path: string) => enrichImportedResearchSource(host, path),
    memoryRecord: memoryRecordDeps(host, memorySource),
    ...webToolImpls(host),
  };
}
