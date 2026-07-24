import type { DiscoveryCandidate, DiscoveryQuery } from "./types";

export const DISCOVERY_RANKING_VERSION = 1;

export interface RankingFactors {
  queryRelevance: number;
  projectOverlap: number;
  citationRelationship: number;
  recency: number;
  openAccess: number;
  metadataCompleteness: number;
}

export const DISCOVERY_RANKING_WEIGHTS: Readonly<RankingFactors> = Object.freeze({
  queryRelevance: 0.35,
  projectOverlap: 0.15,
  citationRelationship: 0.15,
  recency: 0.1,
  openAccess: 0.1,
  metadataCompleteness: 0.15,
});

export interface RankedCandidate {
  candidate: DiscoveryCandidate;
  factors: RankingFactors;
  totalScore: number;
  deterministicRank: number;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function overlap(needles: Set<string>, haystack: Set<string>): number {
  if (needles.size === 0) return 0;
  let matches = 0;
  for (const token of needles) {
    if (haystack.has(token)) matches += 1;
  }
  return matches / needles.size;
}

function candidateText(candidate: DiscoveryCandidate): string {
  return [candidate.title, candidate.authors.join(" "), candidate.publication, candidate.abstract]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function recency(candidate: DiscoveryCandidate, now: Date): number {
  const year = candidate.published?.match(/\b(\d{4})\b/)?.[1];
  if (!year || Number.isNaN(now.getUTCFullYear())) return 0;
  const age = now.getUTCFullYear() - Number(year);
  return Math.max(0, Math.min(1, 1 - age / 20));
}

function metadataCompleteness(candidate: DiscoveryCandidate): number {
  const present = [
    candidate.title.trim().length > 0,
    candidate.authors.length > 0,
    Boolean(candidate.published),
    Boolean(candidate.publication),
    Boolean(candidate.abstract),
    Boolean(candidate.doi || candidate.arxivId || candidate.openAlexId),
    Boolean(candidate.url || candidate.openAccessUrl),
  ];
  return present.filter(Boolean).length / present.length;
}

function factorsFor(query: DiscoveryQuery, candidate: DiscoveryCandidate, now: Date): RankingFactors {
  const text = tokens(candidateText(candidate));
  const projectName = query.projectPath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  return {
    queryRelevance: overlap(tokens(query.text), text),
    projectOverlap: overlap(tokens(projectName), text),
    citationRelationship: candidate.relationship ? 1 : 0,
    recency: recency(candidate, now),
    openAccess: candidate.openAccessUrl ? 1 : 0,
    metadataCompleteness: metadataCompleteness(candidate),
  };
}

function score(factors: RankingFactors): number {
  return (Object.keys(DISCOVERY_RANKING_WEIGHTS) as Array<keyof RankingFactors>)
    .reduce((total, key) => total + factors[key] * DISCOVERY_RANKING_WEIGHTS[key], 0);
}

export function rankCandidates(
  query: DiscoveryQuery,
  candidates: readonly DiscoveryCandidate[],
  now: Date,
): RankedCandidate[] {
  return candidates
    .map((candidate) => {
      const factors = factorsFor(query, candidate, now);
      return { candidate, factors, totalScore: score(factors), deterministicRank: 0 };
    })
    .sort((left, right) => right.totalScore - left.totalScore
      || (left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0))
    .map((candidate, index) => ({ ...candidate, deterministicRank: index + 1 }));
}
