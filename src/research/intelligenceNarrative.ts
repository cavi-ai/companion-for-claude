import type { ApiMessage, ProviderId } from "../providers/types";
import { compareCodeUnits, type ProjectSnapshot } from "./graph";
import type { EpistemicLabel, IntelligenceFinding } from "./intelligence";

export const INTELLIGENCE_NARRATIVE_SCHEMA_VERSION = 1;
const NARRATIVE_CONTEXT_CLIP_CHARS = 1_000;

export interface NarrativeRequest {
  system: string;
  messages: ApiMessage[];
  allowedPaths: string[];
  snapshotFingerprint: string;
}

export interface NarrativeInsight {
  text: string;
  epistemicStatus: EpistemicLabel;
  paths: string[];
}

export interface NarrativeResult {
  briefing: string;
  groups: Array<{ title: string; insights: NarrativeInsight[] }>;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function canonicalSnapshot(snapshot: ProjectSnapshot): unknown {
  return {
    project: {
      path: snapshot.project.path,
      title: snapshot.project.title,
      question: snapshot.project.question,
      audience: snapshot.project.audience,
      stage: snapshot.project.stage,
      status: snapshot.project.status,
    },
    sources: [...snapshot.sources].sort((a, b) => compareCodeUnits(a.path, b.path)).map((source) => ({
      path: source.path,
      title: source.title,
      sourceKind: source.sourceKind,
      canonicalId: source.canonicalId,
      contentFingerprint: source.contentFingerprint,
      authors: source.authors ? [...source.authors].sort(compareCodeUnits) : undefined,
      published: source.published,
      publication: source.publication,
    })),
    evidence: [...snapshot.evidence].sort((a, b) => compareCodeUnits(a.path, b.path)).map((evidence) => ({
      path: evidence.path,
      title: evidence.title,
      source: evidence.source,
      sourceFingerprint: evidence.sourceFingerprint,
      locatorKind: evidence.locatorKind,
      locatorValue: evidence.locatorValue,
      excerpt: evidence.excerpt,
      interpretation: evidence.interpretation,
      reviewState: evidence.reviewState,
    })),
    claims: [...snapshot.claims].sort((a, b) => compareCodeUnits(a.path, b.path)).map((claim) => ({
      path: claim.path,
      title: claim.title,
      proposition: claim.proposition,
      confidence: claim.confidence,
      reviewState: claim.reviewState,
      supporting: sortedUnique(claim.supporting),
      challenging: sortedUnique(claim.challenging),
      contextual: sortedUnique(claim.contextual),
      limitations: [...claim.limitations].sort(compareCodeUnits),
    })),
    questions: [...snapshot.questions].sort((a, b) => compareCodeUnits(a.path, b.path)).map((question) => ({
      path: question.path,
      title: question.title,
      question: question.question,
      status: question.status,
      about: question.about,
    })),
    documents: [...snapshot.documents].sort((a, b) => compareCodeUnits(a.path, b.path)).map((document) => ({
      path: document.path,
      title: document.title,
      documentKind: document.documentKind,
      claims: sortedUnique(document.claims),
    })),
    issues: [...snapshot.issues]
      .map(({ path, code, message }) => ({ path, code, message }))
      .sort((left, right) => compareCodeUnits(stableSerialize(left), stableSerialize(right))),
  };
}

export function fingerprintIntelligenceSnapshot(snapshot: ProjectSnapshot): string {
  return `v${INTELLIGENCE_NARRATIVE_SCHEMA_VERSION}:${hash(stableSerialize(canonicalSnapshot(snapshot)))}`;
}

export function buildNarrativeCacheKey(input: {
  projectPath: string;
  snapshotFingerprint: string;
  narratorMode: "current" | "claude" | "local" | "disabled";
  providerId: ProviderId;
  model: string;
}): string {
  return `intelligence-narrative:v${INTELLIGENCE_NARRATIVE_SCHEMA_VERSION}:${hash(stableSerialize(input))}`;
}

function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.slice(0, NARRATIVE_CONTEXT_CLIP_CHARS);
}

export function buildNarrativeRequest(snapshot: ProjectSnapshot, findings: IntelligenceFinding[]): NarrativeRequest {
  const referenced = new Set(findings.flatMap((finding) => finding.paths));
  const records = [
    ...snapshot.sources.filter(({ path }) => referenced.has(path)).map(({ path, title, sourceKind, canonicalId, published, publication }) => ({ path, title, type: "research-source", sourceKind, canonicalId, published, publication })),
    ...snapshot.evidence.filter(({ path }) => referenced.has(path)).map(({ path, title, source, locatorKind, locatorValue, excerpt, interpretation, reviewState }) => ({ path, title, type: "evidence", source, locatorKind, locatorValue, excerpt: clip(excerpt), interpretation: clip(interpretation), reviewState })),
    ...snapshot.claims.filter(({ path }) => referenced.has(path)).map(({ path, title, proposition, confidence, reviewState, supporting, challenging, contextual, limitations }) => ({ path, title, type: "claim", proposition, confidence, reviewState, supporting: sortedUnique(supporting), challenging: sortedUnique(challenging), contextual: sortedUnique(contextual), limitations: [...limitations].sort(compareCodeUnits) })),
    ...snapshot.questions.filter(({ path }) => referenced.has(path)).map(({ path, title, question, status, about }) => ({ path, title, type: "research-question", question, status, about })),
    ...snapshot.documents.filter(({ path }) => referenced.has(path)).map(({ path, title, documentKind, claims }) => ({ path, title, type: "research-document", documentKind, claims: sortedUnique(claims) })),
  ].sort((a, b) => compareCodeUnits(a.path, b.path));
  const allowedPaths = records.map(({ path }) => path);
  const canonicalFindings = findings
    .map((finding) => ({ ...finding, paths: sortedUnique(finding.paths) }))
    .sort((left, right) => compareCodeUnits(stableSerialize(left), stableSerialize(right)));
  const payload = {
    project: { path: snapshot.project.path, title: snapshot.project.title, question: snapshot.project.question, audience: snapshot.project.audience, stage: snapshot.project.stage },
    findings: canonicalFindings,
    records,
  };
  return {
    system: "Return only JSON matching { briefing: string, groups: [{ title: string, insights: [{ text: string, epistemicStatus: observation | inference | suggested-investigation, paths: string[] }] }] }. Cite only allowed paths. Do not add facts absent from the supplied records.",
    messages: [{ role: "user", content: stableSerialize(payload) }],
    allowedPaths,
    snapshotFingerprint: fingerprintIntelligenceSnapshot(snapshot),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEpistemicLabel(value: unknown): value is EpistemicLabel {
  return value === "observation" || value === "inference" || value === "suggested-investigation";
}

export function parseNarrativeResponse(raw: string, allowedPaths: ReadonlySet<string>): NarrativeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The narrative response was not valid JSON.");
  }
  if (!isObject(parsed) || typeof parsed.briefing !== "string" || !Array.isArray(parsed.groups)) {
    throw new Error("The narrative response did not match the required verified schema.");
  }
  const groups: NarrativeResult["groups"] = [];
  for (const candidate of parsed.groups) {
    if (!isObject(candidate) || typeof candidate.title !== "string" || !Array.isArray(candidate.insights)) continue;
    const insights: NarrativeInsight[] = [];
    for (const value of candidate.insights) {
      if (!isObject(value) || typeof value.text !== "string" || value.text.trim() === "" || !isEpistemicLabel(value.epistemicStatus) || !Array.isArray(value.paths)) continue;
      if (value.paths.length === 0 || !value.paths.every((path) => typeof path === "string" && path.trim() !== "" && allowedPaths.has(path))) continue;
      const paths = sortedUnique(value.paths);
      insights.push({ text: value.text.trim(), epistemicStatus: value.epistemicStatus, paths });
    }
    if (insights.length > 0) groups.push({ title: candidate.title, insights });
  }
  if (groups.length === 0) {
    throw new Error("The narrative response contained no verified insights citing an allowed path or matching the required schema.");
  }
  return { briefing: parsed.briefing, groups };
}
