import type { AdapterWork, CitationDirection, DiscoveryQuery } from "../types";
import { assertSuccessful, DiscoveryAdapterError, parseJson, type DiscoveryHttp } from "./http";
import { safeWebUrl } from "../safeUrl";

const API_ROOT = "https://api.openalex.org";
const MAX_RESULTS = 200;
const DEFAULT_RESULTS = 20;

export interface DiscoveryPage {
  items: AdapterWork[];
  nextCursor?: string;
}

export interface OpenAlexAdapterOptions {
  maxResults: number;
  contact?: string;
}

interface JsonObject { [key: string]: unknown }

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function idTail(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText?.split("/").filter(Boolean).at(-1);
}

function doi(value: unknown): string | undefined {
  return text(value)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase() || undefined;
}

function abstractFromIndex(value: unknown): string | undefined {
  const index = object(value);
  if (index === undefined) return undefined;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (typeof position === "number") words.push([position, word]);
  }
  return words.length === 0 ? undefined : words.sort(([a], [b]) => a - b).map(([, word]) => word).join(" ");
}

function mapWork(value: unknown): AdapterWork | undefined {
  const work = object(value);
  const externalId = idTail(work?.id);
  const title = text(work?.display_name) ?? text(work?.title);
  if (work === undefined || externalId === undefined || title === undefined) return undefined;
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  const authors = authorships.flatMap((authorship) => {
    const name = text(object(object(authorship)?.author)?.display_name);
    return name === undefined ? [] : [name];
  });
  const primaryLocation = object(work.primary_location);
  const bestOpenLocation = object(work.best_oa_location);
  const publication = text(object(primaryLocation?.source)?.display_name);
  const published = text(work.publication_date) ?? (typeof work.publication_year === "number" ? String(work.publication_year) : undefined);
  const referencedWorkIds = Array.isArray(work.referenced_works) ? work.referenced_works.flatMap((id) => idTail(id) ?? []) : undefined;
  const result: AdapterWork = { adapter: "openalex", externalId, openAlexId: externalId, title, authors };
  const fields: Array<[keyof AdapterWork, string | string[] | number | undefined]> = [
    ["doi", doi(work.doi)],
    ["published", published],
    ["publication", publication],
    ["abstract", abstractFromIndex(work.abstract_inverted_index)],
    ["url", safeWebUrl(primaryLocation?.landing_page_url)],
    ["openAccessUrl", safeWebUrl(bestOpenLocation?.pdf_url) ?? safeWebUrl(bestOpenLocation?.landing_page_url)],
    ["referencedWorkIds", referencedWorkIds],
    ["citedByCount", typeof work.cited_by_count === "number" ? work.cited_by_count : undefined],
  ];
  for (const [key, field] of fields) if (field !== undefined) Object.assign(result, { [key]: field });
  return result;
}

function pageFrom(value: unknown): DiscoveryPage {
  const payload = object(value);
  if (payload === undefined || !Array.isArray(payload.results)) throw new DiscoveryAdapterError({ adapter: "openalex", category: "malformed-response" });
  const items = payload.results.flatMap((result) => mapWork(result) ?? []);
  const cursor = text(object(payload.meta)?.next_cursor);
  return { items, ...(cursor === undefined ? {} : { nextCursor: cursor }) };
}

export class OpenAlexAdapter {
  constructor(private readonly http: DiscoveryHttp, private readonly options: OpenAlexAdapterOptions) {}

  async search(query: DiscoveryQuery, cursor?: string, signal?: AbortSignal): Promise<DiscoveryPage> {
    const url = this.listUrl();
    url.searchParams.set("search", query.text);
    this.applyPaging(url, cursor);
    return this.getPage(url, signal);
  }

  async expand(input: { seedOpenAlexId: string; direction: CitationDirection; cursor?: string }, signal?: AbortSignal): Promise<DiscoveryPage> {
    const seedId = idTail(input.seedOpenAlexId);
    if (seedId === undefined) throw new DiscoveryAdapterError({ adapter: "openalex", category: "malformed-response" });
    if (input.direction === "cited-by") {
      const url = this.listUrl();
      url.searchParams.set("filter", `cites:${seedId}`);
      this.applyPaging(url, input.cursor);
      return this.getPage(url, signal);
    }
    const seedUrl = new URL(`/works/${encodeURIComponent(seedId)}`, API_ROOT);
    this.applyContact(seedUrl);
    const seedResponse = await this.http({ url: seedUrl.toString(), ...(signal === undefined ? {} : { signal }) });
    assertSuccessful("openalex", seedResponse);
    const seed = mapWork(parseJson("openalex", seedResponse.body));
    if (seed === undefined) throw new DiscoveryAdapterError({ adapter: "openalex", category: "malformed-response" });
    if (seed.referencedWorkIds === undefined || seed.referencedWorkIds.length === 0) return { items: [] };
    const url = this.listUrl();
    url.searchParams.set("filter", `openalex_id:${seed.referencedWorkIds.join("|")}`);
    this.applyPaging(url, input.cursor);
    return this.getPage(url, signal);
  }

  private listUrl(): URL {
    const url = new URL("/works", API_ROOT);
    this.applyContact(url);
    return url;
  }

  private applyContact(url: URL): void {
    if (this.options.contact?.trim()) url.searchParams.set("mailto", this.options.contact.trim());
  }

  private applyPaging(url: URL, cursor?: string): void {
    const configured = Number.isFinite(this.options.maxResults) ? this.options.maxResults : DEFAULT_RESULTS;
    url.searchParams.set("per-page", String(Math.min(MAX_RESULTS, Math.max(1, Math.floor(configured)))));
    url.searchParams.set("cursor", cursor ?? "*");
  }

  private async getPage(url: URL, signal?: AbortSignal): Promise<DiscoveryPage> {
    const response = await this.http({ url: url.toString(), ...(signal === undefined ? {} : { signal }) });
    assertSuccessful("openalex", response);
    return pageFrom(parseJson("openalex", response.body));
  }
}
