// Zotero Web API item lookup: resolve a zotero_key into bibliographic
// metadata for research_source_import. User libraries only; an API key is
// required for private libraries, optional for public ones. Lookup fires only
// on an explicit import call — never in the background.

import type { AdapterWork } from "../types";
import { assertSuccessful, DiscoveryAdapterError, parseJson, type DiscoveryHttp } from "./http";
import { safeWebUrl } from "../safeUrl";

/** The configured library; undefined disables Zotero resolution. */
export interface ZoteroLibrary {
  userId: string;
  apiKey?: string;
}

interface JsonObject {
  [key: string]: unknown;
}
const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const ITEM_KEY_RE = /^[A-Za-z0-9]{3,32}$/;
const USER_ID_RE = /^\d+$/;
/** Attachments/notes/annotations are not bibliographic sources. */
const NON_SOURCE_TYPES = new Set(["attachment", "note", "annotation"]);

function malformed(): DiscoveryAdapterError {
  return new DiscoveryAdapterError({ adapter: "zotero", category: "malformed-response" });
}

function creatorName(value: unknown): string | undefined {
  const creator = object(value);
  if (creator === undefined) return undefined;
  const single = text(creator.name);
  if (single !== undefined) return single;
  return [text(creator.firstName), text(creator.lastName)].filter(Boolean).join(" ") || undefined;
}

/** Zotero dates are free-form: keep an ISO(-ish) prefix, else the first 4-digit year. */
function date(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const iso = /^(\d{4})(?:-\d{2})?(?:-\d{2})?/.exec(raw);
  if (iso !== null) return iso[0];
  return /\d{4}/.exec(raw)?.[0];
}

export class ZoteroAdapter {
  constructor(
    private readonly http: DiscoveryHttp,
    private readonly library: () => ZoteroLibrary | undefined,
  ) {}

  async lookup(itemKey: string, signal?: AbortSignal): Promise<AdapterWork | undefined> {
    const key = itemKey.trim();
    if (!ITEM_KEY_RE.test(key)) return undefined;
    const library = this.library();
    if (library === undefined || !USER_ID_RE.test(library.userId.trim())) return undefined;
    const headers: Record<string, string> = { "Zotero-API-Version": "3" };
    const apiKey = library.apiKey?.trim();
    if (apiKey) headers["Zotero-API-Key"] = apiKey;
    const url = `https://api.zotero.org/users/${encodeURIComponent(library.userId.trim())}/items/${encodeURIComponent(key)}`;
    const response = await this.http({ url, headers, ...(signal === undefined ? {} : { signal }) });
    if (response.status === 404) return undefined;
    assertSuccessful("zotero", response);

    const item = object(parseJson("zotero", response.body));
    const data = object(item?.data);
    if (item === undefined || data === undefined) throw malformed();
    const itemType = text(data.itemType);
    if (itemType === undefined) throw malformed();
    if (NON_SOURCE_TYPES.has(itemType)) return undefined;
    const title = text(data.title);
    if (title === undefined) throw malformed();

    const authors = (Array.isArray(data.creators) ? data.creators : []).flatMap((creator) => creatorName(creator) ?? []);
    const work: AdapterWork = { adapter: "zotero", externalId: key, zoteroKey: key, title, authors };
    const publication =
      text(data.publicationTitle) ?? text(data.bookTitle) ?? text(data.journalTitle) ??
      text(data.proceedingsTitle) ?? text(data.encyclopediaTitle) ?? text(data.websiteTitle);
    const fields: Array<[keyof AdapterWork, string | undefined]> = [
      ["doi", text(data.DOI)?.toLowerCase()],
      ["published", date(data.date)],
      ["abstract", text(data.abstractNote)],
      ["url", safeWebUrl(text(data.url))],
      ...(publication !== undefined ? [["publication", publication] as [keyof AdapterWork, string]] : []),
    ];
    for (const [field, value] of fields) if (value !== undefined) Object.assign(work, { [field]: value });
    return work;
  }
}
