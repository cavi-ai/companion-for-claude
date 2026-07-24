export const REVIEW_STATES = ["proposed", "reviewed", "rejected"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const RESEARCH_TYPE_NAMES = [
  "research-project",
  "research-source",
  "evidence",
  "claim",
  "research-question",
  "research-document",
] as const;
export type ResearchTypeName = (typeof RESEARCH_TYPE_NAMES)[number];
export type EvidenceRelation = "supports" | "challenges" | "contextualizes";

export interface DiscoverySourceProvenance {
  adapter: "openalex" | "crossref" | "arxiv";
  externalId: string;
}

export interface BaseResearchRecord {
  path: string;
  title: string;
  type: ResearchTypeName;
  project: string;
}

export interface ResearchProjectRecord extends Omit<BaseResearchRecord, "project"> {
  type: "research-project";
  project: string;
  question: string;
  audience?: string;
  stage: "frame" | "gather" | "read" | "reason" | "shape" | "write" | "assure";
  status: "active" | "paused" | "complete";
}

export interface ResearchSourceRecord extends BaseResearchRecord {
  type: "research-source";
  sourceKind: "pdf" | "web" | "doi" | "arxiv" | "zotero" | "vault";
  canonicalId?: string;
  url?: string;
  asset?: string;
  /** Canonical captured Markdown/text persisted in the source note body. */
  capturedContent?: string;
  contentFingerprint?: string;
  doi?: string;
  arxivId?: string;
  zoteroKey?: string;
  authors?: string[];
  published?: string;
  publication?: string;
  abstract?: string;
  openAccessUrl?: string;
  discoveryProvenance?: DiscoverySourceProvenance[];
}

export type SourceLocatorKind = "page" | "section" | "paragraph" | "timestamp" | "quote";

export interface EvidenceRecord extends BaseResearchRecord {
  type: "evidence";
  source: string;
  sourceFingerprint?: string;
  locatorKind?: SourceLocatorKind;
  locatorValue?: string;
  excerpt: string;
  interpretation?: string;
  reviewState: ReviewState;
  model?: string;
}

export interface ClaimRecord extends BaseResearchRecord {
  type: "claim";
  proposition: string;
  confidence: "low" | "moderate" | "high";
  reviewState: ReviewState;
  supports: string[];
  challenges: string[];
  contextualizes: string[];
  limitations: string[];
}

export interface QuestionRecord extends BaseResearchRecord {
  type: "research-question";
  question: string;
  status: "open" | "resolved";
  about?: string;
}

export interface ResearchDocumentRecord extends BaseResearchRecord {
  type: "research-document";
  documentKind: "outline" | "draft";
  claims: string[];
}

export type ResearchRecord = ResearchProjectRecord | ResearchSourceRecord | EvidenceRecord | ClaimRecord | QuestionRecord | ResearchDocumentRecord;

export function isReviewState(value: unknown): value is ReviewState {
  return typeof value === "string" && (REVIEW_STATES as readonly string[]).includes(value);
}
