import { findDuplicate, normalizeArxivId, normalizeDoi } from "../research/identity";
import type { ResearchSourceRecord } from "../research/types";
import { candidateId } from "./identity";
import type { AdapterWork, DiscoveryAdapterId, DiscoveryCandidate, FieldProvenance, MetadataDisagreement } from "./types";
import { safeWebUrl } from "./safeUrl";

const MERGED_FIELDS = [
  "title", "authors", "doi", "arxivId", "openAlexId", "published", "publication", "abstract", "url",
  "openAccessUrl", "referencedWorkIds", "citedByCount",
] as const;
type MergedField = (typeof MERGED_FIELDS)[number];
type ProvenanceValue = string | string[];

const BIBLIOGRAPHIC_FIELDS = new Set<MergedField>(["doi", "title", "authors", "published", "publication", "abstract"]);
const GRAPH_FIELDS = new Set<MergedField>(["openAlexId", "referencedWorkIds", "citedByCount"]);

function nonEmpty(value: unknown): value is string | string[] | number {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
    return value.some((entry) => Boolean(entry.trim()));
  }
  return typeof value === "number";
}

function provenanceValue(value: string | string[] | number): ProvenanceValue {
  if (typeof value === "number") return String(value);
  return Array.isArray(value) ? value.map((entry) => entry.trim()).filter(Boolean) : value.trim();
}

function normalizedValue(field: MergedField, value: ProvenanceValue): string {
  if (Array.isArray(value)) return value.map((entry) => entry.normalize("NFKC").trim().toLowerCase()).join("\u0000");
  if (field === "doi") return normalizeDoi(value);
  if (field === "arxivId") return normalizeArxivId(value);
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function preferredAdapter(field: MergedField): DiscoveryAdapterId | undefined {
  if (BIBLIOGRAPHIC_FIELDS.has(field)) return "crossref";
  if (field === "arxivId") return "arxiv";
  if (GRAPH_FIELDS.has(field)) return "openalex";
  return undefined;
}

function fieldEntries(works: readonly AdapterWork[], field: MergedField): FieldProvenance[] {
  const entries: FieldProvenance[] = [];
  const seen = new Set<string>();
  for (const work of works) {
    const value = work[field];
    if (!nonEmpty(value)) continue;
    const projected = provenanceValue(value);
    const key = `${work.adapter}\u0000${work.externalId}\u0000${normalizedValue(field, projected)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ adapter: work.adapter, externalId: work.externalId, value: projected });
  }
  return entries;
}

function selectWork(works: readonly AdapterWork[], field: MergedField): AdapterWork | undefined {
  const available = works.filter((work) => nonEmpty(work[field]));
  const preferred = preferredAdapter(field);
  return available.find((work) => work.adapter === preferred) ?? available[0];
}

function assertNoStableConflicts(works: readonly AdapterWork[]): void {
  const stableValues = [
    new Set(works.map((work) => work.doi && normalizeDoi(work.doi)).filter(Boolean)),
    new Set(works.map((work) => work.arxivId && normalizeArxivId(work.arxivId)).filter(Boolean)),
    new Set(works.map((work) => work.openAlexId?.trim() || (work.adapter === "openalex" ? work.externalId.trim() : "")).filter(Boolean)),
  ];
  if (stableValues.some((values) => values.size > 1)) throw new Error("Cannot merge works with conflicting stable identifiers");
}

export function mergeAdapterWorks(works: readonly AdapterWork[], existingSources: readonly ResearchSourceRecord[]): DiscoveryCandidate {
  if (works.length === 0) throw new Error("Cannot merge an empty discovery candidate");
  assertNoStableConflicts(works);

  const provenance: Record<string, FieldProvenance[]> = {};
  const disagreements: MetadataDisagreement[] = [];
  for (const field of MERGED_FIELDS) {
    const values = fieldEntries(works, field);
    if (values.length === 0) continue;
    provenance[field] = values;
    if (new Set(values.map(({ value }) => normalizedValue(field, value))).size > 1) disagreements.push({ field, values });
  }

  const selected = Object.fromEntries(MERGED_FIELDS.map((field) => [field, selectWork(works, field)?.[field]])) as Partial<AdapterWork>;
  const selectedUrl = safeWebUrl(selected.url);
  const selectedOpenAccessUrl = safeWebUrl(selected.openAccessUrl);
  if (selectedUrl) selected.url = selectedUrl; else delete selected.url;
  if (selectedOpenAccessUrl) selected.openAccessUrl = selectedOpenAccessUrl; else delete selected.openAccessUrl;
  const openAlexId = selected.openAlexId ?? works.find((work) => work.adapter === "openalex")?.externalId.trim();
  const identityWork: AdapterWork = {
    adapter: works[0]!.adapter,
    externalId: works[0]!.externalId,
    title: selected.title ?? works[0]!.title,
    authors: selected.authors ?? works[0]!.authors,
    ...(selected.doi ? { doi: selected.doi } : {}),
    ...(selected.arxivId ? { arxivId: selected.arxivId } : {}),
    ...(openAlexId ? { openAlexId } : {}),
    ...(selected.published ? { published: selected.published } : {}),
  };
  const id = candidateId(identityWork);
  const sourceProjection: ResearchSourceRecord = {
    path: `discovery:${id}`,
    title: identityWork.title,
    type: "research-source",
    project: existingSources[0]?.project ?? "",
    sourceKind: identityWork.doi ? "doi" : identityWork.arxivId ? "arxiv" : "web",
    authors: identityWork.authors,
    ...(identityWork.doi ? { doi: identityWork.doi } : {}),
    ...(identityWork.arxivId ? { arxivId: identityWork.arxivId } : {}),
    ...(selected.published ? { published: selected.published } : {}),
    ...(selected.publication ? { publication: selected.publication } : {}),
    ...(selected.url ? { url: selected.url } : {}),
  };
  const existingSourcePath = findDuplicate(sourceProjection, existingSources)?.path;

  return {
    id,
    title: identityWork.title,
    authors: identityWork.authors,
    ...(identityWork.doi ? { doi: normalizeDoi(identityWork.doi) } : {}),
    ...(identityWork.arxivId ? { arxivId: normalizeArxivId(identityWork.arxivId) } : {}),
    ...(identityWork.openAlexId ? { openAlexId: identityWork.openAlexId.trim() } : {}),
    ...(selected.published ? { published: selected.published } : {}),
    ...(selected.publication ? { publication: selected.publication } : {}),
    ...(selected.abstract ? { abstract: selected.abstract } : {}),
    ...(selected.url ? { url: selected.url } : {}),
    ...(selected.openAccessUrl ? { openAccessUrl: selected.openAccessUrl } : {}),
    provenance,
    disagreements,
    ...(existingSourcePath ? { existingSourcePath } : {}),
    verification: works.length > 1 ? "verified" : "partial",
  };
}
