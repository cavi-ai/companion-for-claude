import type { CompletionRequest, Provider } from "../providers/types";
import type { RankedCandidate } from "./rank";
import type { DiscoveryQuery } from "./types";

const MAX_CANDIDATE_PROJECTION_CHARS = 4_000;
const MAX_REASON_CHARS = 300;

export interface RerankOrderItem {
  id: string;
  reason: string;
}

export interface RerankResponse {
  order: RerankOrderItem[];
}

export interface ModelRankedCandidate extends RankedCandidate {
  modelRank: number;
  reason: string;
}

interface CandidateProjection {
  id: string;
  title: string;
  authors: string[];
  year: string | undefined;
  venue: string | undefined;
  abstractExcerpt: string | undefined;
  deterministicFactors: RankedCandidate["factors"];
  relationship: RankedCandidate["candidate"]["relationship"] | undefined;
}

function clip(value: string | undefined, maximum: number): string | undefined {
  return value ? value.slice(0, maximum) : undefined;
}

function projectCandidate(ranked: RankedCandidate): CandidateProjection {
  const candidate = ranked.candidate;
  const projection: CandidateProjection = {
    id: candidate.id,
    title: candidate.title,
    authors: [...candidate.authors],
    year: candidate.published,
    venue: candidate.publication,
    abstractExcerpt: candidate.abstract,
    deterministicFactors: { ...ranked.factors },
    relationship: candidate.relationship ? { ...candidate.relationship } : undefined,
  };

  // Apply deterministic per-field ceilings before enforcing the aggregate limit.
  projection.title = clip(projection.title, 1_000) ?? "";
  projection.authors = projection.authors.slice(0, 50).map((author) => clip(author, 200) ?? "");
  projection.year = clip(projection.year, 40);
  projection.venue = clip(projection.venue, 500);
  projection.abstractExcerpt = clip(projection.abstractExcerpt, 2_000);

  while (JSON.stringify(projection).length > MAX_CANDIDATE_PROJECTION_CHARS) {
    if (projection.abstractExcerpt) {
      projection.abstractExcerpt = projection.abstractExcerpt.slice(0, -1) || undefined;
    } else if (projection.authors.length > 0) {
      projection.authors.pop();
    } else if (projection.venue) {
      projection.venue = projection.venue.slice(0, -1) || undefined;
    } else if (projection.title.length > 0) {
      projection.title = projection.title.slice(0, -1);
    } else {
      throw new Error(`Candidate ${candidate.id} cannot fit the rerank projection limit`);
    }
  }

  return projection;
}

export function buildRerankRequest(
  query: DiscoveryQuery,
  candidates: readonly RankedCandidate[],
  model: string,
  signal?: AbortSignal,
): CompletionRequest {
  const payload = {
    query: query.text,
    projectPath: query.projectPath,
    candidates: candidates.map(projectCandidate),
  };
  return {
    system: [
      "Rerank the supplied scholarly candidates for the research query.",
      "Return JSON only in this exact shape: {\"order\":[{\"id\":string,\"reason\":string}]}.",
      "Include every supplied candidate ID exactly once. Do not invent, remove, or alter IDs.",
    ].join(" "),
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    model,
    maxTokens: 2_048,
    temperature: 0,
    ...(signal ? { signal } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRerankResponse(raw: string, candidateIds: readonly string[]): RerankResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Rerank response must be a valid JSON object");
  }
  if (!isObject(parsed) || !Array.isArray(parsed.order)) {
    throw new Error("Rerank response must be a JSON object with an order array");
  }

  const knownIds = new Set(candidateIds);
  if (knownIds.size !== candidateIds.length) {
    throw new Error("Rerank input must contain every candidate exactly once");
  }
  const seen = new Set<string>();
  const order = parsed.order.map((item): RerankOrderItem => {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.reason !== "string") {
      throw new Error("Every rerank order item must contain a string id and reason");
    }
    if (!knownIds.has(item.id)) {
      throw new Error(`Rerank response contains unknown candidate: ${item.id}`);
    }
    if (seen.has(item.id)) {
      throw new Error("Rerank response must contain every candidate exactly once");
    }
    seen.add(item.id);
    return { id: item.id, reason: item.reason.slice(0, MAX_REASON_CHARS) };
  });

  if (order.length !== candidateIds.length || seen.size !== knownIds.size) {
    throw new Error("Rerank response must contain every candidate exactly once");
  }
  return { order };
}

export async function rerankCandidates(
  provider: Provider,
  query: DiscoveryQuery,
  candidates: readonly RankedCandidate[],
  model: string,
  signal?: AbortSignal,
): Promise<ModelRankedCandidate[]> {
  const raw = await provider.complete(buildRerankRequest(query, candidates, model, signal));
  const parsed = parseRerankResponse(raw, candidates.map(({ candidate }) => candidate.id));
  const byId = new Map(candidates.map((candidate) => [candidate.candidate.id, candidate]));
  return parsed.order.map(({ id, reason }, index) => ({
    ...byId.get(id)!,
    modelRank: index + 1,
    reason,
  }));
}
