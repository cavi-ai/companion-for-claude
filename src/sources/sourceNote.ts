import { buildFrontmatter, normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import type { SourceRecord } from "./types";

/** Flatten a SourceRecord into frontmatter: type, its typed fields, the enrichment marker, provenance. */
export function sourceFrontmatter(record: SourceRecord, baseTags: string[]): FrontmatterData {
  const fm: FrontmatterData = { type: record.type };
  for (const [k, v] of Object.entries(record.fields)) fm[k] = v;
  if (record.provenance.url) fm.url = record.provenance.url;
  if (record.provenance.assetPath) fm.asset = record.provenance.assetPath;
  fm.source_enriched = true;
  fm.schema_version = record.provenance.schemaVersion;
  fm.captured_at = record.provenance.capturedAt;
  fm.enriched_by = record.provenance.enrichedBy;
  fm.tags = normalizeTags(baseTags);
  return fm;
}

/** Render a sidecar markdown note for a non-markdown asset (frontmatter + heading + embed). */
export function buildSidecarNote(record: SourceRecord, assetFileName: string, baseTags: string[]): string {
  const fm = sourceFrontmatter(record, baseTags);
  const title = String(record.fields.title ?? assetFileName);
  const lines: string[] = [buildFrontmatter(fm), "", `# ${title}`, ""];
  if (record.fields.summary) lines.push(String(record.fields.summary), "");
  lines.push(`![[${assetFileName}]]`, "");
  return lines.join("\n");
}
