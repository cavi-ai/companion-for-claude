export type DiscoveryAdapterId = "openalex" | "crossref" | "arxiv";
export type CitationDirection = "references" | "cited-by";

export interface DiscoveryQuery {
  text: string;
  projectPath: string;
}

export interface AdapterWork {
  adapter: DiscoveryAdapterId;
  externalId: string;
  title: string;
  authors: string[];
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  published?: string;
  publication?: string;
  abstract?: string;
  url?: string;
  openAccessUrl?: string;
  referencedWorkIds?: string[];
  citedByCount?: number;
}

export interface FieldProvenance {
  adapter: DiscoveryAdapterId;
  externalId: string;
  value: string | string[];
}

export interface MetadataDisagreement {
  field: string;
  values: FieldProvenance[];
}

export interface CitationRelationship {
  seedId: string;
  direction: CitationDirection;
  adapter: "openalex";
}

export interface DiscoveryCandidate {
  id: string;
  title: string;
  authors: string[];
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  published?: string;
  publication?: string;
  abstract?: string;
  url?: string;
  openAccessUrl?: string;
  provenance: Record<string, FieldProvenance[]>;
  disagreements: MetadataDisagreement[];
  relationship?: CitationRelationship;
  existingSourcePath?: string;
  verification: "verified" | "partial";
}
