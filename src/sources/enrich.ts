import { App, TFile, normalizePath } from "obsidian";
import type { FieldValue, RawCapture, SourceRecord, SourceType, SourceTypeSchema } from "./types";
import { detectType, parseClipUrl, sourceUrlFromProperties } from "./detect";
import { getSchema, type SchemaOverrides } from "./registry";
import { parseCsvMeta } from "./csvMeta";
import { extractFields, type ExtractCompletionOpts } from "./extract";
import { sanitize } from "../memory/sanitize";
import { sourceFrontmatter, buildSidecarNote } from "./sourceNote";
import { applySourceFrontmatter, mergeSourceMarkdown, sourceProperties } from "./frontmatterMerge";
import { sanitizeFileName } from "../artifacts/parse";
import { validateEnrichment, validateMergedSourceProvenance } from "./enrichmentQuality";
import { stripFrontmatter } from "../markdown/frontmatter";
import { prepareSourceMarkdown } from "./sourceMarkdown";
import type { WebCapture } from "../research/webCapture";

export interface EnrichDeps {
  app: App;
  complete: (system: string, user: string, opts?: ExtractCompletionOpts) => Promise<string>;
  overrides?: SchemaOverrides | undefined;
  baseTags: string[];
  resolveTags?: ((tags: string[]) => string[]) | undefined;
  enrichedBy: "claude" | "local";
  now: () => string;
  /** Last-moment lifecycle gate: a completed model result may outlive the plugin. */
  assertActive?: () => void;
  /** Reads the source page of a clip that arrived with an empty body. */
  captureWeb?: WebCapture | undefined;
}

export interface EnrichResult {
  file: TFile;
  type: SourceType;
  record: SourceRecord;
  /** The clip arrived empty and was enriched from its source page, which fills its body. */
  readFromPage: boolean;
}

/** The source page of an empty clip could not be fetched; the note is left untouched for a retry. */
export class ClipPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipPageError";
  }
}

/**
 * Web Clipper saves some pages with no content (a Reddit post can arrive as a
 * blank note), so an empty clip is read from its source URL instead.
 * Undefined when the clip has a body or carries no URL. An unreadable page
 * leaves the note unchanged so enrichment can be retried.
 */
async function emptyClipBody(deps: EnrichDeps, capture: Extract<RawCapture, { kind: "markdown" }>): Promise<string | undefined> {
  if (!deps.captureWeb || stripFrontmatter(capture.content).trim()) return undefined;
  const url = capture.url ?? parseClipUrl(capture.content);
  if (!url) return undefined;
  try {
    const markdown = (await deps.captureWeb(url))?.markdown;
    if (!markdown?.trim()) throw new Error("The page returned no readable content");
    return markdown;
  } catch (e) {
    let host = url;
    try { host = new URL(url).hostname; } catch { /* keep the raw URL */ }
    const reason = e instanceof Error ? e.message : String(e);
    throw new ClipPageError(`This clip arrived empty and its page at ${host} could not be read (${reason}). Retry from the Source Inbox, or paste the page's text into the note.`);
  }
}

function csvPreview(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").slice(0, 6).join("\n");
}

function sanitizeFields(fields: Record<string, FieldValue>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") out[k] = sanitize(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => sanitize(x));
    else out[k] = v;
  }
  return out;
}

/** Rehydrate only source-owned values from the final atomic frontmatter merge. */
function mergedSourceRecord(
  frontmatter: Readonly<Record<string, unknown>>,
  schema: SourceTypeSchema,
  provenanceUrl: string | undefined,
  assetPath: string | undefined,
): SourceRecord {
  const fields: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (Object.prototype.hasOwnProperty.call(frontmatter, field.key)) fields[field.key] = frontmatter[field.key];
  }
  return {
    type: frontmatter.type,
    fields,
    provenance: {
      url: provenanceUrl,
      assetPath,
      capturedAt: frontmatter.captured_at,
      schemaVersion: frontmatter.schema_version,
      enrichedBy: frontmatter.enriched_by,
    },
  } as unknown as SourceRecord;
}

/**
 * Model-sourced schema values the capture already carries in frontmatter
 * (e.g. stamped by a Companion-generated Web Clipper template). Only
 * type-compatible, non-empty values count — anything else is left to the model.
 */
export function prefilledFields(schema: SourceTypeSchema, frontmatter: Record<string, unknown> | undefined): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  if (!frontmatter) return out;
  for (const field of schema.fields) {
    if (field.source !== "model") continue;
    const v = frontmatter[field.key];
    if (v === undefined || v === null || v === "") continue;
    if (field.type === "string[]") {
      const arr = Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (arr.length > 0) out[field.key] = arr;
    } else if (field.type === "number") {
      if (typeof v === "number" && Number.isFinite(v)) out[field.key] = v;
    } else if (typeof v === "string" && v.trim()) {
      out[field.key] = v.trim();
    }
  }
  return out;
}

/** Run a capture through the pipeline and write the typed result. */
export async function enrichCapture(deps: EnrichDeps, capture: RawCapture): Promise<EnrichResult> {
  if (capture.kind === "markdown") capture = { ...capture, content: prepareSourceMarkdown(capture.content).content };
  const type = detectType(capture);
  const schema = getSchema(type, deps.overrides);

  const derived: Record<string, FieldValue> = {};
  const pageBody = capture.kind === "markdown" ? await emptyClipBody(deps, capture) : undefined;
  let content = pageBody ? `${capture.content.trimEnd()}\n\n${pageBody}` : capture.content;
  if (capture.kind === "datafile" && capture.ext === "csv") {
    const meta = parseCsvMeta(capture.content);
    if (meta) {
      derived.columns = meta.columns;
      derived.rows = meta.rows;
    }
    content = csvPreview(capture.content);
  }

  // Values the clipper already stamped (title/author/site/published/…) are
  // trusted as-is: the model is only asked for what the page couldn't say.
  const prefilled =
    capture.kind === "markdown" ? prefilledFields(schema, sourceProperties(capture.content)) : {};
  const { fields } = await extractFields(schema, content, derived, { complete: deps.complete }, 2, prefilled);
  const safeFields = sanitizeFields(fields);
  const url = capture.kind === "markdown" ? capture.url ?? parseClipUrl(capture.content) : undefined;

  const record: SourceRecord = {
    type,
    fields: safeFields,
    provenance: {
      url,
      capturedAt: deps.now(),
      schemaVersion: schema.version,
      enrichedBy: deps.enrichedBy,
      assetPath: capture.kind === "datafile" ? capture.path : undefined,
    },
  };
  validateEnrichment(record, schema, { captureBasename: capture.basename });

  if (capture.kind === "markdown") {
    const file = deps.app.vault.getAbstractFileByPath(capture.path);
    if (!(file instanceof TFile)) throw new Error(`note not found: ${capture.path}`);
    deps.assertActive?.();
    await applySourceFrontmatter(
      deps.app,
      file,
      sourceFrontmatter(record, deps.baseTags, deps.resolveTags),
      (frontmatter) => {
        deps.assertActive?.();
        if (pageBody !== undefined && sourceUrlFromProperties(frontmatter) !== (parseClipUrl(capture.content) ?? url)) {
          throw new ClipPageError("This clip's source URL changed while enrichment was running. No changes were saved. Retry from the Source Inbox.");
        }
        const context = { captureBasename: capture.basename };
        const provenance = validateMergedSourceProvenance(frontmatter);
        validateEnrichment(
          mergedSourceRecord(frontmatter, schema, provenance.url, provenance.assetPath),
          schema,
          context,
        );
        // Web Clipper notes may retain their URL under the supported legacy
        // `source` alias even when canonical `url` is also present.
        if (provenance.source !== undefined && provenance.source !== provenance.url) {
          validateEnrichment(
            mergedSourceRecord(frontmatter, schema, provenance.source, provenance.assetPath),
            schema,
            context,
          );
        }
      },
      pageBody,
    );
    return { file, type, record, readFromPage: pageBody !== undefined };
  }
  const dir = capture.path.includes("/") ? capture.path.slice(0, capture.path.lastIndexOf("/")) : "";
  const fm = sourceFrontmatter(record, deps.baseTags, deps.resolveTags);
  const derivedKeys = new Set(schema.fields.filter((field) => field.source === "derived").map((field) => field.key));
  const owns = (content: string): boolean => {
    const properties = sourceProperties(content);
    return properties.source_enriched === true && properties.asset === capture.path;
  };
  // Find legacy sidecars in the source folder too: the model title may change,
  // and a newly written sidecar may not have reached the metadata cache yet.
  const candidates = deps.app.vault.getMarkdownFiles().filter((file) =>
    (file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "") === dir
    || deps.app.metadataCache.getFileCache(file)?.frontmatter?.asset === capture.path,
  );
  for (const file of candidates) {
    let owned = false;
    try { owned = owns(await deps.app.vault.read(file)); } catch { /* Unrelated invalid YAML is not ours to repair. */ }
    if (!owned) continue;
    deps.assertActive?.();
    await deps.app.vault.process(file, (current) => {
      deps.assertActive?.();
      if (!owns(current)) throw new Error("The sidecar ownership changed. The note was not updated; retry enrichment.");
      return mergeSourceMarkdown(current, fm, undefined, undefined, derivedKeys);
    });
    return { file, type, record, readFromPage: false };
  }
  // New names derive from the asset, never from model output. A collision is
  // another note's property, including a folder or a concurrent creation.
  const base = sanitizeFileName(capture.basename) || "Source";
  const noteContent = buildSidecarNote(record, `${capture.basename}.${capture.ext}`, deps.baseTags, deps.resolveTags);
  const fold = (path: string): string => path.normalize("NFC").toLowerCase();
  const occupied = (path: string): boolean =>
    (deps.app.vault.getAllLoadedFiles?.() ?? deps.app.vault.getFiles()).some((entry) => fold(entry.path) === fold(path));
  for (let suffix = 1; ; suffix++) {
    const stem = suffix === 1 ? base : `${base} ${suffix}`;
    const path = normalizePath(dir ? `${dir}/${stem}.md` : `${stem}.md`);
    if (occupied(path)) continue;
    deps.assertActive?.();
    try {
      const file = await deps.app.vault.create(path, noteContent);
      return { file, type, record, readFromPage: false };
    } catch (error) {
      if (!occupied(path) && !(await deps.app.vault.adapter.exists?.(path))) throw error;
    }
  }
}
