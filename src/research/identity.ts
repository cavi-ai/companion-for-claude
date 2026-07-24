import type { ResearchSourceRecord } from "./types";

export function normalizeDoi(value: string): string {
  return value.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
}

export function normalizeArxivId(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "")
    .toLowerCase();
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

export function canonicalSourceId(
  source: Pick<ResearchSourceRecord, "canonicalId" | "url" | "doi" | "arxivId" | "zoteroKey">,
): string | undefined {
  const doi = source.doi && normalizeDoi(source.doi);
  if (doi) return `doi:${doi}`;
  const arxiv = source.arxivId && normalizeArxivId(source.arxivId);
  if (arxiv) return `arxiv:${arxiv}`;
  if (source.zoteroKey?.trim()) return `zotero:${source.zoteroKey.trim()}`;
  if (source.url?.trim()) return `url:${normalizeUrl(source.url)}`;
  return source.canonicalId?.trim() || undefined;
}

type StableKey = "doi" | "arxivId" | "zoteroKey" | "url";

const stableValue = (source: ResearchSourceRecord, key: StableKey): string | undefined => {
  const value = source[key];
  if (!value?.trim()) return undefined;
  if (key === "doi") return normalizeDoi(value);
  if (key === "arxivId") return normalizeArxivId(value);
  if (key === "url") return normalizeUrl(value);
  return value.trim();
};

function hasStableConflict(left: ResearchSourceRecord, right: ResearchSourceRecord): boolean {
  return (["doi", "arxivId", "zoteroKey", "url"] as const).some((key) => {
    const a = stableValue(left, key);
    const b = stableValue(right, key);
    return Boolean(a && b && a !== b);
  });
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function bibliographyFingerprint(source: ResearchSourceRecord): string | undefined {
  const title = normalizeText(source.title);
  const year = source.published?.match(/\b(\d{4})\b/)?.[1];
  const author = source.authors?.[0] && normalizeText(source.authors[0]);
  return title && year && author ? `${title}|${year}|${author}` : undefined;
}

export function findDuplicate<T extends ResearchSourceRecord>(candidate: T, existing: readonly T[]): T | undefined {
  const eligible = existing.filter((source) => !hasStableConflict(candidate, source));

  for (const key of ["doi", "arxivId", "zoteroKey", "url"] as const) {
    const candidateValue = stableValue(candidate, key);
    if (!candidateValue) continue;
    const match = eligible.find((source) => stableValue(source, key) === candidateValue);
    if (match) return match;
  }

  const fingerprint = bibliographyFingerprint(candidate);
  if (fingerprint) {
    const match = eligible.find((source) => bibliographyFingerprint(source) === fingerprint);
    if (match) return match;
  }

  if (candidate.contentFingerprint?.trim()) {
    return eligible.find((source) => source.contentFingerprint?.trim() === candidate.contentFingerprint?.trim());
  }
  return undefined;
}
