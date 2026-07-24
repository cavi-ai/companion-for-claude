import type { AdapterWork } from "../types";
import { assertSuccessful, DiscoveryAdapterError, type DiscoveryHttp } from "./http";
import { safeWebUrl } from "../safeUrl";

const normalizeSpace = (value: string | null | undefined): string | undefined => value?.replace(/\s+/g, " ").trim() || undefined;
const normalizeLookupId = (value: string): string => value.trim().replace(/^arxiv:/i, "").replace(/v\d+$/i, "");
const publicId = (value: string | null | undefined): string | undefined => normalizeSpace(value)?.split("/").filter(Boolean).at(-1)?.replace(/^arxiv:/i, "");

function directChildren(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === localName);
}

function childText(parent: Element, localName: string): string | undefined {
  return normalizeSpace(directChildren(parent, localName)[0]?.textContent);
}

function malformed(): DiscoveryAdapterError {
  return new DiscoveryAdapterError({ adapter: "arxiv", category: "malformed-response" });
}

export class ArxivAdapter {
  constructor(private readonly http: DiscoveryHttp) {}

  async lookup(arxivId: string, signal?: AbortSignal): Promise<AdapterWork | undefined> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("id_list", normalizeLookupId(arxivId));
    const response = await this.http({ url: url.toString(), ...(signal === undefined ? {} : { signal }) });
    if (response.status === 404) return undefined;
    assertSuccessful("arxiv", response);
    let document: Document;
    try {
      document = new DOMParser().parseFromString(response.body, "application/xml");
    } catch {
      throw malformed();
    }
    if (document.querySelector("parsererror") !== null || document.documentElement.localName !== "feed") throw malformed();
    const entry = Array.from(document.documentElement.children).find((child) => child.localName === "entry");
    if (entry === undefined) return undefined;
    const externalId = publicId(childText(entry, "id"));
    const title = childText(entry, "title");
    if (externalId === undefined || title === undefined) throw malformed();
    const authors = directChildren(entry, "author").flatMap((author) => childText(author, "name") ?? []);
    const links = directChildren(entry, "link");
    const result: AdapterWork = { adapter: "arxiv", externalId, arxivId: externalId, title, authors };
    const fields: Array<[keyof AdapterWork, string | undefined]> = [
      ["doi", childText(entry, "doi")?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase()],
      ["published", childText(entry, "published")?.slice(0, 10)],
      ["abstract", childText(entry, "summary")],
      ["url", safeWebUrl(links.find((link) => link.getAttribute("rel") === "alternate")?.getAttribute("href"))],
      ["openAccessUrl", safeWebUrl(links.find((link) => link.getAttribute("type") === "application/pdf" || link.getAttribute("title") === "pdf")?.getAttribute("href"))],
    ];
    for (const [key, field] of fields) if (field !== undefined) Object.assign(result, { [key]: field });
    return result;
  }
}
