import { App, TFile, normalizePath } from "obsidian";
import type { FieldValue, RawCapture, SourceRecord, SourceType } from "./types";
import { detectType, parseClipUrl } from "./detect";
import { getSchema, type SchemaOverrides } from "./registry";
import { parseCsvMeta } from "./csvMeta";
import { extractFields } from "./extract";
import { sanitize } from "../memory/sanitize";
import { sourceFrontmatter, buildSidecarNote } from "./sourceNote";
import { applySourceFrontmatter } from "./frontmatterMerge";
import { sanitizeFileName } from "../artifacts/parse";

export interface EnrichDeps {
  app: App;
  complete: (system: string, user: string) => Promise<string>;
  overrides?: SchemaOverrides | undefined;
  baseTags: string[];
  enrichedBy: "claude" | "local";
  now: () => string;
}

export interface EnrichResult {
  file: TFile;
  type: SourceType;
  record: SourceRecord;
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

/** Run a capture through the pipeline and write the typed result. */
export async function enrichCapture(deps: EnrichDeps, capture: RawCapture): Promise<EnrichResult> {
  const type = detectType(capture);
  const schema = getSchema(type, deps.overrides);

  const derived: Record<string, FieldValue> = {};
  let content = capture.content;
  if (capture.kind === "datafile" && capture.ext === "csv") {
    const meta = parseCsvMeta(capture.content);
    if (meta) {
      derived.columns = meta.columns;
      derived.rows = meta.rows;
    }
    content = csvPreview(capture.content);
  }

  const { fields } = await extractFields(schema, content, derived, { complete: deps.complete });
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

  if (capture.kind === "markdown") {
    const file = deps.app.vault.getAbstractFileByPath(capture.path);
    if (!(file instanceof TFile)) throw new Error(`note not found: ${capture.path}`);
    await applySourceFrontmatter(deps.app, file, sourceFrontmatter(record, deps.baseTags));
    return { file, type, record };
  }

  const dir = capture.path.includes("/") ? capture.path.slice(0, capture.path.lastIndexOf("/")) : "";
  const base = sanitizeFileName(String(record.fields.title ?? capture.basename));
  const assetFileName = `${capture.basename}.${capture.ext}`;
  const noteContent = buildSidecarNote(record, assetFileName, deps.baseTags);
  const path = normalizePath(dir ? `${dir}/${base}.md` : `${base}.md`);
  const existing = deps.app.vault.getAbstractFileByPath(path);
  let file: TFile;
  if (existing instanceof TFile) {
    await deps.app.vault.modify(existing, noteContent);
    file = existing;
  } else {
    file = await deps.app.vault.create(path, noteContent);
  }
  return { file, type, record };
}
