import type { AdapterWork } from "../types";
import { assertSuccessful, DiscoveryAdapterError, parseJson, type DiscoveryHttp } from "./http";

interface JsonObject { [key: string]: unknown }
const object = (value: unknown): JsonObject | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

function firstText(value: unknown): string | undefined {
  return Array.isArray(value) ? text(value[0]) : text(value);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

function decodeEntitiesOnce(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (entity, name: string) => HTML_ENTITIES[name] ?? entity);
}

function stripMarkup(value: unknown): string | undefined {
  const source = text(value);
  if (source === undefined) return undefined;
  return decodeEntitiesOnce(source.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() || undefined;
}

function date(value: unknown): string | undefined {
  const parts = object(value)?.["date-parts"];
  const first = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] : undefined;
  if (first === undefined || typeof first[0] !== "number") return undefined;
  return [String(first[0]).padStart(4, "0"), ...(typeof first[1] === "number" ? [String(first[1]).padStart(2, "0")] : []), ...(typeof first[2] === "number" ? [String(first[2]).padStart(2, "0")] : [])].join("-");
}

function mapWork(value: unknown): AdapterWork | undefined {
  const work = object(value);
  const externalId = text(work?.DOI)?.toLowerCase();
  const title = firstText(work?.title);
  if (work === undefined || externalId === undefined || title === undefined) return undefined;
  const authors = (Array.isArray(work.author) ? work.author : []).flatMap((author) => {
    const record = object(author);
    const parts = [text(record?.given), text(record?.family)].filter((part): part is string => part !== undefined).join(" ");
    const name = text(record?.name) ?? (parts || undefined);
    return name === undefined ? [] : [name];
  });
  const result: AdapterWork = { adapter: "crossref", externalId, doi: externalId, title, authors };
  const fields: Array<[keyof AdapterWork, string | undefined]> = [
    ["published", date(work["published-print"]) ?? date(work.published) ?? date(work.issued)],
    ["publication", firstText(work["container-title"])],
    ["abstract", stripMarkup(work.abstract)],
    ["url", text(work.URL)],
  ];
  for (const [key, field] of fields) if (field !== undefined) Object.assign(result, { [key]: field });
  return result;
}

export class CrossrefAdapter {
  constructor(private readonly http: DiscoveryHttp) {}

  async lookupDoi(doi: string, signal?: AbortSignal): Promise<AdapterWork | undefined> {
    const url = new URL(`/works/${encodeURIComponent(doi.trim())}`, "https://api.crossref.org");
    const response = await this.http({ url: url.toString(), ...(signal === undefined ? {} : { signal }) });
    if (response.status === 404) return undefined;
    assertSuccessful("crossref", response);
    const payload = object(parseJson("crossref", response.body));
    if (payload === undefined || !("message" in payload)) throw new DiscoveryAdapterError({ adapter: "crossref", category: "malformed-response" });
    const work = mapWork(payload.message);
    if (work === undefined) throw new DiscoveryAdapterError({ adapter: "crossref", category: "malformed-response" });
    return work;
  }
}
