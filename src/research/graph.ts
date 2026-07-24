import type { ParseIssue } from "./parse";
import type {
  ClaimRecord,
  EvidenceRecord,
  QuestionRecord,
  ResearchDocumentRecord,
  ResearchProjectRecord,
  ResearchRecord,
  ResearchSourceRecord,
} from "./types";

export interface ProjectClaim extends ClaimRecord {
  supporting: string[];
  challenging: string[];
  contextual: string[];
  trustedSupportCount: number;
}

export interface ProjectHealth {
  claimCount: number;
  trustedSupportCount: number;
  supportedClaimCount: number;
}

export interface ProjectSnapshot {
  project: ResearchProjectRecord;
  sources: ResearchSourceRecord[];
  evidence: EvidenceRecord[];
  claims: ProjectClaim[];
  questions: QuestionRecord[];
  documents: ResearchDocumentRecord[];
  issues: ParseIssue[];
  health: ProjectHealth;
}

function freezeRecord<T extends ResearchRecord>(record: T): Readonly<T> {
  const clone = { ...record };
  for (const key of ["authors", "supports", "challenges", "contextualizes", "limitations", "claims"] as const) {
    const value = clone[key as keyof T];
    if (Array.isArray(value)) Object.assign(clone, { [key]: Object.freeze([...value]) });
  }
  return Object.freeze(clone);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort(compareCodeUnits);
}

function sortRecords<T extends ResearchRecord>(records: T[]): T[] {
  return records.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function hasLocator(evidence: EvidenceRecord): boolean {
  return Boolean(evidence.locatorKind && evidence.locatorValue?.trim());
}

export function isStaleEvidence(evidence: EvidenceRecord, source: ResearchSourceRecord | undefined): boolean {
  return Boolean(source && evidence.sourceFingerprint && source.contentFingerprint !== evidence.sourceFingerprint);
}

export function isTrustedEvidence(evidence: EvidenceRecord | undefined, source: ResearchSourceRecord | undefined): boolean {
  return Boolean(evidence && source && evidence.reviewState === "reviewed" && hasLocator(evidence) && !isStaleEvidence(evidence, source));
}

export function buildProjectSnapshot(projectPath: string, records: ResearchRecord[], parseIssues: ParseIssue[]): ProjectSnapshot {
  const grouped = new Map<string, ResearchRecord[]>();
  const issues = parseIssues.map((entry) => Object.freeze({ ...entry }));
  for (const record of records) {
    const candidates = grouped.get(record.path) ?? [];
    candidates.push(record);
    grouped.set(record.path, candidates);
  }
  const unique = new Map<string, ResearchRecord>();
  for (const [path, candidates] of grouped) {
    const ordered = [...candidates].sort((left, right) => compareCodeUnits(stableSerialize(left), stableSerialize(right)));
    unique.set(path, freezeRecord(ordered[0]!));
    for (let index = 1; index < ordered.length; index += 1) {
      issues.push(Object.freeze({ path, code: "invalid-value", message: `Duplicate research record path: ${path}` }));
    }
  }
  issues.sort((left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code) || compareCodeUnits(left.message, right.message));

  const project = unique.get(projectPath);
  if (project?.type !== "research-project") throw new Error(`Research project not found: ${projectPath}`);
  const scoped = [...unique.values()].filter((record) => record.path === projectPath || record.project === projectPath);
  const sources = sortRecords(scoped.filter((record): record is ResearchSourceRecord => record.type === "research-source"));
  const evidence = sortRecords(scoped.filter((record): record is EvidenceRecord => record.type === "evidence"));
  const evidenceByPath = new Map(evidence.map((record) => [record.path, record]));
  const sourceByPath = new Map(sources.map((record) => [record.path, record]));
  const claims = sortRecords(scoped.filter((record): record is ClaimRecord => record.type === "claim")).map((record): ProjectClaim => {
    const supporting = uniquePaths(record.supports);
    const challenging = uniquePaths(record.challenges);
    const contextual = uniquePaths(record.contextualizes);
    Object.freeze(supporting);
    Object.freeze(challenging);
    Object.freeze(contextual);
    const trustedSupportCount = supporting.filter((path) => {
      const item = evidenceByPath.get(path);
      return isTrustedEvidence(item, item ? sourceByPath.get(item.source) : undefined);
    }).length;
    return Object.freeze({ ...record, supports: supporting, challenges: challenging, contextualizes: contextual, supporting, challenging, contextual, trustedSupportCount });
  });
  const questions = sortRecords(scoped.filter((record): record is QuestionRecord => record.type === "research-question"));
  const documents = sortRecords(scoped.filter((record): record is ResearchDocumentRecord => record.type === "research-document"));
  const health = Object.freeze({
    claimCount: claims.length,
    trustedSupportCount: claims.reduce((sum, claim) => sum + claim.trustedSupportCount, 0),
    supportedClaimCount: claims.filter((claim) => claim.trustedSupportCount > 0).length,
  });
  return Object.freeze({ project, sources: Object.freeze(sources), evidence: Object.freeze(evidence), claims: Object.freeze(claims), questions: Object.freeze(questions), documents: Object.freeze(documents), issues: Object.freeze(issues), health }) as ProjectSnapshot;
}
