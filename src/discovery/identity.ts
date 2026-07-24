import { normalizeArxivId, normalizeDoi } from "../research/identity";
import type { AdapterWork } from "./types";

const normalizeText = (value: string): string =>
  value.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function candidateId(work: AdapterWork): string {
  const doi = work.doi && normalizeDoi(work.doi);
  if (doi) return `doi:${doi}`;
  const arxivId = work.arxivId && normalizeArxivId(work.arxivId);
  if (arxivId) return `arxiv:${arxivId}`;
  const openAlexId = work.openAlexId?.trim() || (work.adapter === "openalex" ? work.externalId.trim() : "");
  if (openAlexId) return `openalex:${openAlexId}`;

  const title = normalizeText(work.title);
  const year = work.published?.match(/\b(\d{4})\b/)?.[1];
  const firstAuthor = work.authors[0] && normalizeText(work.authors[0]);
  if (title && year && firstAuthor) return `fingerprint:${title}|${year}|${firstAuthor}`;
  throw new Error("Discovery candidate has no stable identity");
}
