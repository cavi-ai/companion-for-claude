import type { AuditFinding } from "./audit";
import { challengedClaimCopy, findingCopy } from "./findingCopy";
import { compareCodeUnits, isStaleEvidence, isTrustedEvidence, recordBasename, type ProjectClaim, type ProjectSnapshot } from "./graph";
import type { IntelligenceFinding } from "./intelligence";
import { activeDocument, type SectionSummary } from "./sectionStatus";
import type { EvidenceRelation } from "./types";

export type ClaimStatus = "rejected" | "needs-check" | "unsupported" | "thin" | "challenged" | "changed" | "drafted" | "not-drafted" | "not-in-outline" | "ready";

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  rejected: "Rejected",
  "needs-check": "Needs check",
  unsupported: "Unsupported",
  thin: "Thin",
  challenged: "Challenged",
  changed: "Changed since drafted",
  drafted: "Drafted",
  "not-drafted": "Not drafted",
  "not-in-outline": "Not in outline",
  ready: "Ready",
};

export interface PassageRow {
  path: string;
  title: string;
  relation: EvidenceRelation;
  sourceTitle: string;
  locator?: string;
  trusted: boolean;
  flag?: "missing" | "stale" | "no locator" | "unchecked";
}

export interface ClaimCard {
  path: string;
  title: string;
  proposition: string;
  counts: { supports: number; challenges: number; context: number };
  trustedSupports: number;
  status: ClaimStatus;
  notes: string[];
  passages: PassageRow[];
}

export interface RecordLink { path: string; title: string }

export interface ArgumentModel {
  fixFirst: AuditFinding[];
  cards: ClaimCard[];
  rejected: ClaimCard[];
  unusedPassages: RecordLink[];
  unreadSources: RecordLink[];
}

const FIX_FIRST: ReadonlySet<AuditFinding["code"]> = new Set(["broken-reference", "invalid-record", "unverifiable-source"]);
const SHOWN_AS_STATUS: ReadonlySet<AuditFinding["code"]> = new Set(["unreviewed-claim", "rejected-claim", "unsupported-claim", "unused-evidence"]);
const MAX_NOTES = 3;

export function claimOrder(snapshot: ProjectSnapshot): ProjectClaim[] {
  const rank = new Map((activeDocument(snapshot)?.claims ?? []).map((path, index) => [path, index]));
  return [...snapshot.claims].sort((left, right) => (rank.get(left.path) ?? Infinity) - (rank.get(right.path) ?? Infinity) || compareCodeUnits(left.path, right.path));
}

function claimStatus(claim: ProjectClaim, contradicted: boolean, inOutline: boolean | undefined, section: SectionSummary | undefined): ClaimStatus {
  if (claim.reviewState === "rejected") return "rejected";
  if (claim.reviewState === "proposed") return "needs-check";
  if (claim.trustedSupportCount === 0) return "unsupported";
  if (claim.trustedSupportCount === 1) return "thin";
  if ((claim.challenging.length > 0 || contradicted) && claim.limitations.length === 0) return "challenged";
  if (section?.state === "changed") return "changed";
  if (section?.state === "drafted") return "drafted";
  if (inOutline === undefined) return "ready";
  return inOutline ? "not-drafted" : "not-in-outline";
}

function passageRows(snapshot: ProjectSnapshot, claim: ProjectClaim): PassageRow[] {
  const relations: Array<[EvidenceRelation, readonly string[]]> = [["supports", claim.supporting], ["challenges", claim.challenging], ["contextualizes", claim.contextual]];
  return relations.flatMap(([relation, paths]) => paths.map((path): PassageRow => {
    const evidence = snapshot.evidence.find((item) => item.path === path);
    if (!evidence) return { path, title: recordBasename(path), relation, sourceTitle: "", trusted: false, flag: "missing" };
    const source = snapshot.sources.find((item) => item.path === evidence.source);
    const locator = evidence.locatorKind && evidence.locatorValue?.trim() ? `${evidence.locatorKind} ${evidence.locatorValue.trim()}` : undefined;
    const flag = isStaleEvidence(evidence, source) ? "stale" : !locator ? "no locator" : evidence.reviewState !== "reviewed" ? "unchecked" : undefined;
    return { path, title: evidence.title, relation, sourceTitle: source?.title ?? recordBasename(evidence.source), ...(locator ? { locator } : {}), trusted: isTrustedEvidence(evidence, source), ...(flag ? { flag } : {}) };
  }));
}

function claimNotes(claim: ProjectClaim, status: ClaimStatus, audit: AuditFinding[], intelligence: IntelligenceFinding[]): string[] {
  const related = new Set([claim.path, ...claim.supporting, ...claim.challenging, ...claim.contextual]);
  const notes = [
    ...(status === "challenged" && claim.challenging.length ? [challengedClaimCopy(claim.title, claim.challenging.length).reason] : []),
    ...audit.filter(({ code, path }) => related.has(path) && !SHOWN_AS_STATUS.has(code) && !FIX_FIRST.has(code)).map(({ code, path }) => findingCopy(code, recordBasename(path)).label),
    ...intelligence.filter(({ category, paths }) => (category === "contradiction" || category === "method-difference") && paths.includes(claim.path)).map(({ title }) => title),
  ];
  return [...new Set(notes)].slice(0, MAX_NOTES);
}

export function buildArgument(snapshot: ProjectSnapshot, audit: AuditFinding[], intelligence: IntelligenceFinding[], sections?: SectionSummary[]): ArgumentModel {
  const document = activeDocument(snapshot);
  const outline = document ? new Set(document.claims) : undefined;
  const byClaim = new Map((sections ?? []).map((section) => [section.claimPath, section]));
  const all = claimOrder(snapshot).map((claim): ClaimCard => {
    const contradicted = intelligence.some(({ category, paths }) => category === "contradiction" && paths.includes(claim.path));
    const status = claimStatus(claim, contradicted, outline ? outline.has(claim.path) : undefined, byClaim.get(claim.path));
    return {
      path: claim.path,
      title: claim.title,
      proposition: claim.proposition,
      counts: { supports: claim.supporting.length, challenges: claim.challenging.length, context: claim.contextual.length },
      trustedSupports: claim.trustedSupportCount,
      status,
      notes: claimNotes(claim, status, audit, intelligence),
      passages: passageRows(snapshot, claim),
    };
  });
  const linked = new Set(snapshot.claims.flatMap(({ supporting, challenging, contextual }) => [...supporting, ...challenging, ...contextual]));
  const read = new Set(snapshot.evidence.map(({ source }) => source));
  return {
    fixFirst: audit.filter(({ code }) => FIX_FIRST.has(code)),
    cards: all.filter(({ status }) => status !== "rejected"),
    rejected: all.filter(({ status }) => status === "rejected"),
    unusedPassages: snapshot.evidence.filter(({ path }) => !linked.has(path)).map(({ path, title }) => ({ path, title })),
    unreadSources: snapshot.sources.filter(({ path }) => !read.has(path)).map(({ path, title }) => ({ path, title })),
  };
}
