import {
  RESEARCH_TYPE_NAMES,
  REVIEW_STATES,
  type ResearchRecord,
  type ResearchTypeName,
  type DiscoverySourceProvenance,
} from "./types";

export interface ResearchNoteInput {
  path: string;
  frontmatter?: Record<string, unknown>;
  body: string;
}

export interface ParseIssue {
  path: string;
  code: "unknown-type" | "missing-field" | "invalid-value" | "missing-locator";
  message: string;
}

export interface ParseResearchResult {
  record?: ResearchRecord;
  issues: ParseIssue[];
}

type IssueCode = ParseIssue["code"];

function issue(input: ResearchNoteInput, issues: ParseIssue[], code: IssueCode, message: string): void {
  issues.push({ path: input.path, code, message });
}

function scalar(input: ResearchNoteInput, issues: ParseIssue[], key: string, required = false): string | undefined {
  const value = input.frontmatter?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value !== undefined) issue(input, issues, "invalid-value", `${key} must be a non-empty string`);
  else if (required) issue(input, issues, "missing-field", `Missing required field: ${key}`);
  return undefined;
}

function oneOf<T extends string>(input: ResearchNoteInput, issues: ParseIssue[], key: string, values: readonly T[], required = true): T | undefined {
  const value = scalar(input, issues, key, required);
  if (value === undefined) return undefined;
  if ((values as readonly string[]).includes(value)) return value as T;
  issue(input, issues, "invalid-value", `${key} must be one of: ${values.join(", ")}`);
  return undefined;
}

function recoveredOneOf<T extends string>(input: ResearchNoteInput, issues: ParseIssue[], key: string, values: readonly T[], fallback: T): T {
  return oneOf(input, issues, key, values) ?? fallback;
}

function stringList(input: ResearchNoteInput, issues: ParseIssue[], key: string): string[] {
  const value = input.frontmatter?.[key];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
    return value.map((item) => (item as string).trim());
  }
  issue(input, issues, "invalid-value", `${key} must be a list of non-empty strings`);
  return [];
}

function discoveryProvenance(input: ResearchNoteInput, issues: ParseIssue[]): DiscoverySourceProvenance[] {
  const value = input.frontmatter?.discovery_provenance;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(input, issues, "invalid-value", "discovery_provenance must be a list of provenance objects");
    return [];
  }
  const accepted: DiscoverySourceProvenance[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issue(input, issues, "invalid-value", "discovery_provenance entries must be provenance objects");
      continue;
    }
    const adapter = (entry as Record<string, unknown>).adapter;
    const externalId = (entry as Record<string, unknown>).external_id;
    if ((adapter !== "openalex" && adapter !== "crossref" && adapter !== "arxiv") || typeof externalId !== "string" || !externalId.trim()) {
      issue(input, issues, "invalid-value", "discovery_provenance entries require an allowed adapter and non-empty external_id");
      continue;
    }
    accepted.push({ adapter, externalId: externalId.trim() });
  }
  return accepted;
}

function httpUrl(input: ResearchNoteInput, issues: ParseIssue[], key: string): string | undefined {
  const value = scalar(input, issues, key);
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    if (protocol === "http:" || protocol === "https:") return value;
  } catch { /* reported below */ }
  issue(input, issues, "invalid-value", `${key} must be a valid http: or https: URL`);
  return undefined;
}

function wikilink(input: ResearchNoteInput, issues: ParseIssue[], key: string, required = false): string | undefined {
  const value = scalar(input, issues, key, required);
  if (value === undefined) return undefined;
  const match = value.match(/^\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]$/);
  const target = match?.[1]?.trim();
  if (target) return target;
  issue(input, issues, "invalid-value", `${key} must be a wikilink`);
  return undefined;
}

function wikilinkList(input: ResearchNoteInput, issues: ParseIssue[], key: string): string[] {
  const value = input.frontmatter?.[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(input, issues, "invalid-value", `${key} must be a list of wikilinks`);
    return [];
  }
  const targets: string[] = [];
  for (const entry of value) {
    const match = typeof entry === "string" ? entry.trim().match(/^\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]$/) : undefined;
    const target = match?.[1]?.trim();
    if (target) targets.push(target);
    else issue(input, issues, "invalid-value", `${key} entries must be wikilinks`);
  }
  return targets;
}

function locatorValue(input: ResearchNoteInput, issues: ParseIssue[]): string | undefined {
  const value = input.frontmatter?.locator_value;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value !== undefined) issue(input, issues, "invalid-value", "locator_value must be a string or number");
  return undefined;
}

function excerptFromBody(body: string): string {
  return body
    .split("\n")
    .filter((line) => /^> ?/.test(line))
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
}

function interpretationFromBody(body: string): string | undefined {
  const match = body.match(/(?:^|\n)Interpretation:\s*([^\n]+(?:\n(?!\s*#)[^\n]+)*)/i);
  return match?.[1]?.trim() || undefined;
}

function capturedContentFromBody(input: ResearchNoteInput, issues: ParseIssue[]): string | undefined {
  if (input.body.includes("<!-- cavi:capture version=")) {
    const match = /<!-- cavi:capture version=([^\s]+) chars=([^\s]+) -->\n/.exec(input.body);
    if (!match) {
      issue(input, issues, "invalid-value", "Malformed length-addressed captured content header");
      return undefined;
    }
    if (match[1] !== "1") {
      issue(input, issues, "invalid-value", "Unsupported captured content encoding version");
      return undefined;
    }
    const rawLength = match[2] ?? "";
    if (!/^\d+$/.test(rawLength)) {
      issue(input, issues, "invalid-value", "Malformed length-addressed captured content length");
      return undefined;
    }
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length)) {
      issue(input, issues, "invalid-value", "Malformed length-addressed captured content length");
      return undefined;
    }
    const start = match.index + match[0].length;
    const end = start + length;
    const delimiter = "\n<!-- cavi:capture:end -->";
    if (end > input.body.length || input.body.slice(end, end + delimiter.length) !== delimiter) {
      issue(input, issues, "invalid-value", "Malformed length-addressed captured content payload or delimiter");
      return undefined;
    }
    return input.body.slice(start, end);
  }
  if (input.body.includes("<!-- cavi:capture:start -->")) {
    issue(input, issues, "invalid-value", "Legacy unencoded captured content is ambiguous and untrusted; re-import the source");
  } else if (input.body.includes("<!-- cavi:capture encoding=")) {
    issue(input, issues, "invalid-value", "Legacy encoded captured content is untrusted; re-import the source");
  }
  return undefined;
}

function parseTypedRecord(type: ResearchTypeName, input: ResearchNoteInput, issues: ParseIssue[]): ParseResearchResult {
  const title = scalar(input, issues, "title", true);
  const project = wikilink(input, issues, "project", true);
  if (!title || !project) return { issues };

  if (type === "research-project") {
    const question = scalar(input, issues, "question", true);
    const stage = recoveredOneOf(input, issues, "stage", ["frame", "gather", "read", "reason", "shape", "write", "assure"] as const, "frame");
    const status = recoveredOneOf(input, issues, "status", ["active", "paused", "complete"] as const, "active");
    if (!question) return { issues };
    const audience = scalar(input, issues, "audience");
    return { record: { path: input.path, title, type, project, question, ...(audience ? { audience } : {}), stage, status }, issues };
  }

  if (type === "research-source") {
    const rawSourceKind = scalar(input, issues, "source_kind", true);
    if (!rawSourceKind) return { issues };
    const sourceKind = recoveredOneOf(input, issues, "source_kind", ["pdf", "web", "doi", "arxiv", "zotero", "vault"] as const, "vault");
    const canonicalId = scalar(input, issues, "canonical_id");
    const url = scalar(input, issues, "url");
    const asset = wikilink(input, issues, "asset");
    const contentFingerprint = scalar(input, issues, "content_fingerprint");
    const capturedContent = capturedContentFromBody(input, issues);
    const doi = scalar(input, issues, "doi");
    const arxivId = scalar(input, issues, "arxiv_id");
    const zoteroKey = scalar(input, issues, "zotero_key");
    const authors = stringList(input, issues, "authors");
    const published = scalar(input, issues, "published");
    const publication = scalar(input, issues, "publication");
    const abstract = scalar(input, issues, "abstract");
    const openAccessUrl = httpUrl(input, issues, "open_access_url");
    const provenance = discoveryProvenance(input, issues);
    return { record: { path: input.path, title, type, project, sourceKind, ...(canonicalId ? { canonicalId } : {}), ...(url ? { url } : {}), ...(asset ? { asset } : {}), ...(capturedContent !== undefined ? { capturedContent } : {}), ...(contentFingerprint ? { contentFingerprint } : {}), ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}), ...(zoteroKey ? { zoteroKey } : {}), ...(authors.length ? { authors } : {}), ...(published ? { published } : {}), ...(publication ? { publication } : {}), ...(abstract ? { abstract } : {}), ...(openAccessUrl ? { openAccessUrl } : {}), ...(provenance.length ? { discoveryProvenance: provenance } : {}) }, issues };
  }

  if (type === "evidence") {
    const source = wikilink(input, issues, "source", true);
    const sourceFingerprint = scalar(input, issues, "source_fingerprint");
    const excerpt = excerptFromBody(input.body);
    if (!excerpt) issue(input, issues, "missing-field", "Missing required evidence excerpt");
    const reviewState = recoveredOneOf(input, issues, "review_state", REVIEW_STATES, "proposed");
    const locatorKind = oneOf(input, issues, "locator_kind", ["page", "section", "paragraph", "timestamp", "quote"] as const, false);
    const parsedLocatorValue = locatorValue(input, issues);
    if (!locatorKind || !parsedLocatorValue) issue(input, issues, "missing-locator", "Evidence should identify both locator_kind and locator_value");
    if (!source || !excerpt) return { issues };
    const interpretation = interpretationFromBody(input.body);
    const model = scalar(input, issues, "model");
    return { record: { path: input.path, title, type, project, source, ...(sourceFingerprint ? { sourceFingerprint } : {}), ...(locatorKind ? { locatorKind } : {}), ...(parsedLocatorValue ? { locatorValue: parsedLocatorValue } : {}), excerpt, ...(interpretation ? { interpretation } : {}), reviewState, ...(model ? { model } : {}) }, issues };
  }

  if (type === "claim") {
    const proposition = scalar(input, issues, "proposition", true);
    const confidence = recoveredOneOf(input, issues, "confidence", ["low", "moderate", "high"] as const, "moderate");
    const reviewState = recoveredOneOf(input, issues, "review_state", REVIEW_STATES, "proposed");
    if (!proposition) return { issues };
    return { record: { path: input.path, title, type, project, proposition, confidence, reviewState, supports: wikilinkList(input, issues, "supports"), challenges: wikilinkList(input, issues, "challenges"), contextualizes: wikilinkList(input, issues, "contextualizes"), limitations: stringList(input, issues, "limitations") }, issues };
  }

  if (type === "research-question") {
    const question = scalar(input, issues, "question", true);
    const status = recoveredOneOf(input, issues, "status", ["open", "resolved"] as const, "open");
    if (!question) return { issues };
    const about = wikilink(input, issues, "about");
    return { record: { path: input.path, title, type, project, question, status, ...(about ? { about } : {}) }, issues };
  }

  const rawDocumentKind = scalar(input, issues, "document_kind", true);
  if (!rawDocumentKind) return { issues };
  const documentKind = recoveredOneOf(input, issues, "document_kind", ["outline", "draft"] as const, "outline");
  return { record: { path: input.path, title, type, project, documentKind, claims: wikilinkList(input, issues, "claims") }, issues };
}

export function parseResearchRecord(input: ResearchNoteInput): ParseResearchResult {
  const type = input.frontmatter?.type;
  if (typeof type !== "string" || !(RESEARCH_TYPE_NAMES as readonly string[]).includes(type)) return { issues: [] };
  return parseTypedRecord(type as ResearchTypeName, input, []);
}

/** Parse a note already selected by canonical research layout, reporting damaged metadata. */
export function parseResearchCandidate(input: ResearchNoteInput): ParseResearchResult {
  const type = input.frontmatter?.type;
  if (type === undefined) return { issues: [{ path: input.path, code: "missing-field", message: "Missing required field: type" }] };
  if (typeof type !== "string") return { issues: [{ path: input.path, code: "invalid-value", message: "type must be a non-empty string" }] };
  if (!(RESEARCH_TYPE_NAMES as readonly string[]).includes(type)) return { issues: [{ path: input.path, code: "unknown-type", message: `Unknown research type: ${type}` }] };
  return parseTypedRecord(type as ResearchTypeName, input, []);
}
