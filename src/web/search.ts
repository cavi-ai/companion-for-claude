// Web search for agent mode: pluggable engines behind one result shape.
// DuckDuckGo's HTML endpoint is the zero-setup default (no API key); Brave is
// the keyed upgrade. Pure — HTTP and HTML parsing are injected, so tests drive
// fixtures directly. Network calls fire only on an explicit agent tool call.

import { safeWebUrl } from "../discovery/safeUrl";
import type { DiscoveryHttp } from "../discovery/adapters/http";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchEngine = "duckduckgo" | "brave";

export interface DuckDuckGoIo {
  fetchHtml: (url: string) => Promise<string>;
  parseHtml: (html: string) => Document;
}

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_TEXT = 300;

const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

/** DDG result links redirect through /l/?uddg=<encoded> — unwrap to the real URL. */
function unwrapDuckDuckGoHref(href: string): string | undefined {
  const direct = safeWebUrl(href);
  if (direct) return direct;
  // Protocol-relative redirect: //duckduckgo.com/l/?uddg=…
  const withScheme = href.startsWith("//") ? `https:${href}` : href.startsWith("/") ? `https://html.duckduckgo.com${href}` : href;
  try {
    const url = new URL(withScheme);
    const uddg = url.searchParams.get("uddg");
    return uddg ? safeWebUrl(decodeURIComponent(uddg)) : undefined;
  } catch {
    return undefined;
  }
}

/** Keyless search via the DuckDuckGo HTML endpoint. Throws on transport failure. */
export async function duckDuckGoSearch(io: DuckDuckGoIo, query: string, count: number): Promise<WebSearchResult[]> {
  const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const doc = io.parseHtml(await io.fetchHtml(url));
  const results: WebSearchResult[] = [];
  for (const anchor of Array.from(doc.querySelectorAll("a.result__a"))) {
    const title = clean(anchor.textContent);
    const href = anchor.getAttribute("href") ?? "";
    const target = unwrapDuckDuckGoHref(href);
    if (!title || !target) continue;
    const container = anchor.closest(".result");
    const snippet = clean(container?.querySelector(".result__snippet")?.textContent);
    results.push({ title, url: target, snippet });
    if (results.length >= count) break;
  }
  return results;
}

interface JsonObject {
  [key: string]: unknown;
}
const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** Brave Web Search API (keyed). Throws a status-coded error on non-2xx. */
export async function braveSearch(http: DiscoveryHttp, apiKey: string, query: string, count: number): Promise<WebSearchResult[]> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(count, 20))}`;
  const response = await http({
    url,
    headers: { accept: "application/json", "accept-encoding": "gzip", "x-subscription-token": apiKey.trim() },
  });
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 401 || response.status === 403) throw new Error(`Brave Search rejected the key (${response.status}) — check the API key in settings.`);
    if (response.status === 429) throw new Error("Brave Search rate limit hit — wait a moment and retry.");
    throw new Error(`Brave Search failed (${response.status}).`);
  }
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new Error("Brave Search returned an unreadable response.");
  }
  const results = object(object(json)?.web)?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult[] = [];
  for (const entry of results) {
    const item = object(entry);
    const title = text(item?.title);
    const target = text(item?.url);
    if (!title || !target || !safeWebUrl(target)) continue;
    out.push({ title: clean(title), url: target, snippet: clean(text(item?.description)) });
    if (out.length >= count) break;
  }
  return out;
}

/** Compact tool-result rendering: numbered hits with URLs the model can cite. */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No web results for: ${query}`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ""}`);
  return `Web results for: ${query}\n\n${lines.join("\n\n")}`;
}
