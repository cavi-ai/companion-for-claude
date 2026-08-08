import type { FieldType, SourceRecord, SourceTypeSchema } from "./types";
import { sanitize } from "../memory/sanitize";

const REDACTION_MARKER = "‹REDACTED›";
const PLACEHOLDER_TITLES = new Set([
  "no title",
  "title",
  "unknown title",
  "untitled",
  "untitled document",
]);
const GENERIC_FILENAME_TITLES = new Set([
  "article", "capture", "clipping", "dataset", "document", "file", "note", "source", "title", "untitled", "video",
]);

export interface EnrichmentValidationContext {
  /** Extension-free source name used only to identify filename-derived generic titles. */
  captureBasename?: string | undefined;
}

export class EnrichmentQualityError extends Error {
  constructor(readonly errors: string[]) {
    super(`enrichment quality failed: ${errors.join("; ")}`);
    this.name = "EnrichmentQualityError";
  }
}

function hasSecretBearingContent(value: string): boolean {
  return value.includes(REDACTION_MARKER) || sanitize(value) !== value;
}

function containsSecretBearingContent(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return hasSecretBearingContent(value);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, nested]) => (
    hasSecretBearingContent(key) || containsSecretBearingContent(nested, seen)
  ));
}

export interface MergedSourceProvenance {
  url?: string | undefined;
  source?: string | undefined;
  assetPath?: string | undefined;
}

/** Validate and type preserved live provenance before constructing a SourceRecord. */
export function validateMergedSourceProvenance(
  frontmatter: Readonly<Record<string, unknown>>,
): MergedSourceProvenance {
  const errors: string[] = [];
  const provenance: MergedSourceProvenance = {};
  const candidates = [
    ["url", "url"],
    ["source", "source"],
    ["asset", "assetPath"],
  ] as const;
  for (const [frontmatterKey, provenanceKey] of candidates) {
    const value = frontmatter[frontmatterKey];
    if (value === undefined || value === null) continue;
    if (containsSecretBearingContent(value)) {
      errors.push(`provenance.${provenanceKey}: contains secret-bearing content`);
    }
    if (typeof value !== "string") {
      errors.push(`provenance.${provenanceKey}: expected string`);
    } else {
      provenance[provenanceKey] = value;
    }
  }
  if (errors.length > 0) throw new EnrichmentQualityError(errors);
  return provenance;
}

function normalizedTitlePart(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .trim();
}

function filenameStem(value: string): string | undefined {
  const normalized = normalizedTitlePart(value);
  const filename = /^(.+)\.([a-z0-9]{1,8})$/i.exec(normalized);
  return filename?.[1] === undefined ? undefined : normalizedTitlePart(filename[1]);
}

function normalizedCaptureBasename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizedTitlePart(value);
  return filenameStem(normalized) ?? normalized;
}

function isPlaceholderTitle(value: string, captureBasename?: string): boolean {
  const normalized = normalizedTitlePart(value);
  if (normalized.length === 0 || PLACEHOLDER_TITLES.has(normalized)) return true;
  const stem = filenameStem(normalized);
  if (stem === undefined) return false;
  if (PLACEHOLDER_TITLES.has(stem)) return true;
  return GENERIC_FILENAME_TITLES.has(stem) && stem === normalizedCaptureBasename(captureBasename);
}

function fieldTypeError(type: FieldType, value: unknown): string | undefined {
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? undefined : "expected number";
  if (type === "string[]") return Array.isArray(value) && value.every((item) => typeof item === "string") ? undefined : "expected string[]";
  if (typeof value === "string") return undefined;
  return type === "string" ? "expected string" : `expected ${type} string`;
}

function missingRequired(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0) || (Array.isArray(value) && value.length === 0);
}

export function validateEnrichment(
  record: SourceRecord,
  schema: SourceTypeSchema,
  context: EnrichmentValidationContext = {},
): void {
  const errors: string[] = [];
  const fields = record?.fields as Record<string, unknown> | undefined;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new EnrichmentQualityError(["fields: expected a record"]);
  }

  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      if (hasSecretBearingContent(value)) errors.push(`fields.${key}: contains secret-bearing content`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (typeof item === "string" && hasSecretBearingContent(item)) errors.push(`fields.${key}[${index}]: contains secret-bearing content`);
      }
    }
  }

  if (record.type !== schema.type) errors.push(`record type ${record.type}: does not match ${schema.type} schema`);
  const declared = new Map(schema.fields.map((field) => [field.key, field]));
  for (const field of schema.fields) {
    const value = fields[field.key];
    if (missingRequired(value)) {
      if (field.required) errors.push(`fields.${field.key}: missing required field`);
      continue;
    }
    const typeError = fieldTypeError(field.type, value);
    if (typeError) errors.push(`fields.${field.key}: ${typeError}`);
  }
  for (const key of Object.keys(fields)) {
    if (!declared.has(key)) errors.push(`fields.${key}: not declared by ${schema.type} schema`);
  }

  for (const key of ["url", "assetPath", "capturedAt", "enrichedBy"] as const) {
    const value = record.provenance[key];
    if (typeof value === "string" && hasSecretBearingContent(value)) {
      errors.push(`provenance.${key}: contains secret-bearing content`);
    }
  }

  const title = fields.title;
  if (typeof title !== "string" || isPlaceholderTitle(title, context.captureBasename)) {
    errors.push("title: must be a meaningful, non-placeholder title");
  }

  const summary = fields.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    errors.push("summary: must be a non-empty string");
  } else if ([...summary].length > 200) {
    errors.push("summary: must be at most 200 characters");
  }

  if (errors.length > 0) throw new EnrichmentQualityError(errors);
}

export function markdownBody(content: string): string {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return content;

  let offset = opening[0].length;
  while (offset <= content.length) {
    const nextLf = content.indexOf("\n", offset);
    const lineEnd = nextLf === -1 ? content.length : nextLf > offset && content[nextLf - 1] === "\r" ? nextLf - 1 : nextLf;
    const line = content.slice(offset, lineEnd);
    if (/^---[ \t]*$/.test(line)) return content.slice(nextLf === -1 ? lineEnd : nextLf + 1);
    if (nextLf === -1) break;
    offset = nextLf + 1;
  }
  return content;
}

export function assertBodyPreserved(before: string, after: string): void {
  if (markdownBody(before) !== markdownBody(after)) {
    throw new EnrichmentQualityError(["markdown body changed during enrichment"]);
  }
}
