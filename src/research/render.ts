import { buildFrontmatter, type FrontmatterData } from "../indexing/frontmatter";
import type { ResearchRecord } from "./types";

function quoteExcerpt(excerpt: string): string {
  return excerpt.split("\n").map((line) => `> ${line}`).join("\n");
}

function wikilink(path: string): string {
  return `[[${path}]]`;
}

function researchFrontmatter(data: FrontmatterData, exactStrings: Record<string, string | undefined> = {}, exactJson: Record<string, string | undefined> = {}): string {
  let rendered = buildFrontmatter(data);
  for (const [key, value] of Object.entries(exactStrings)) {
    if (value !== undefined) rendered = rendered.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${JSON.stringify(value)}`);
  }
  for (const [key, value] of Object.entries(exactJson)) {
    if (value !== undefined) rendered = rendered.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`);
  }
  return rendered;
}

export function renderResearchRecord(record: ResearchRecord): string {
  const common: FrontmatterData = { title: record.title, type: record.type, project: wikilink(record.project) };
  let frontmatter: FrontmatterData;
  let body: string;

  switch (record.type) {
    case "research-project":
      frontmatter = { ...common, question: record.question, audience: record.audience, stage: record.stage, status: record.status };
      body = `# Research project\n\n## Question\n\n${record.question}`;
      break;
    case "research-source":
      frontmatter = { ...common, source_kind: record.sourceKind, canonical_id: record.canonicalId, url: record.url, asset: record.asset ? wikilink(record.asset) : undefined, content_fingerprint: record.contentFingerprint, doi: record.doi, arxiv_id: record.arxivId, zotero_key: record.zoteroKey, authors: record.authors, published: record.published, publication: record.publication, abstract: record.abstract, open_access_url: record.openAccessUrl, discovery_provenance: record.discoveryProvenance ? JSON.stringify(record.discoveryProvenance) : undefined };
      body = record.capturedContent === undefined
        ? "# Research source\n\n## Notes"
        : `# Research source\n\n## Captured content\n\n<!-- cavi:capture version=1 chars=${record.capturedContent.length} -->\n${record.capturedContent}\n<!-- cavi:capture:end -->\n\n## Notes`;
      break;
    case "evidence":
      frontmatter = { ...common, source: wikilink(record.source), source_fingerprint: record.sourceFingerprint, locator_kind: record.locatorKind, locator_value: record.locatorValue, review_state: record.reviewState, model: record.model };
      // The ^excerpt block anchor lets other notes deep-link or embed the
      // exact excerpt ([[note#^excerpt]] / ![[note#^excerpt]]).
      body = `# Evidence\n\n${quoteExcerpt(record.excerpt)}\n\n^excerpt${record.interpretation ? `\n\nInterpretation: ${record.interpretation}` : ""}`;
      break;
    case "claim":
      frontmatter = { ...common, proposition: record.proposition, confidence: record.confidence, review_state: record.reviewState, supports: record.supports.map(wikilink), challenges: record.challenges.map(wikilink), contextualizes: record.contextualizes.map(wikilink), limitations: record.limitations };
      body = `# Claim\n\n## Proposition\n\n${record.proposition}${record.limitations.length ? `\n\n> [!warning]- Limitations\n${record.limitations.map((l) => `> - ${l}`).join("\n")}` : ""}`;
      break;
    case "research-question":
      frontmatter = { ...common, question: record.question, status: record.status, about: record.about ? wikilink(record.about) : undefined };
      body = `# Research question\n\n## Question\n\n${record.question}`;
      break;
    case "research-document":
      frontmatter = { ...common, document_kind: record.documentKind, claims: record.claims.map(wikilink) };
      body = `# Research document\n\n## ${record.documentKind === "outline" ? "Outline" : "Draft"}`;
      break;
  }

  const exactStrings = record.type === "evidence"
    ? { locator_value: record.locatorValue }
    : record.type === "research-source"
      ? { arxiv_id: record.arxivId }
      : {};
  const exactJson = record.type === "research-source"
    ? { discovery_provenance: record.discoveryProvenance ? JSON.stringify(record.discoveryProvenance.map(({ adapter, externalId }) => ({ adapter, external_id: externalId }))) : undefined }
    : {};
  return `${researchFrontmatter(frontmatter, exactStrings, exactJson)}\n\n${body}\n`;
}
