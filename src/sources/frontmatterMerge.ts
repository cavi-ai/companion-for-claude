import { App, TFile } from "obsidian";
import { normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import { assertBodyPreserved } from "./enrichmentQuality";
import { prepareSourceMarkdown, renderSourceMarkdown } from "./sourceMarkdown";

export type MergedFrontmatterValidator = (frontmatter: Readonly<Record<string, unknown>>) => void;

/** Merge source-owned keys atomically against the vault's current content. */
function unionTags(existing: unknown, added: unknown): string[] {
  const toList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? [v.trim()] : [];
  return normalizeTags([...toList(existing), ...toList(added)]);
}

const SYSTEM_KEYS = new Set(["type", "source_enriched", "schema_version", "captured_at", "enriched_by"]);

function missing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0) || (Array.isArray(value) && value.length === 0);
}

/** Parse the actual note, never a potentially stale metadata-cache entry. */
export function sourceProperties(content: string): Record<string, unknown> {
  return prepareSourceMarkdown(content).properties;
}

/**
 * Pure merge of source-owned keys. Live values win; system enrichment markers
 * deliberately refresh. The body is preserved, except that `fillBody` fills a
 * body that is still empty (a clip re-read from its source page).
 */
export function mergeSourceMarkdown(
  content: string,
  fm: FrontmatterData,
  validateMerged?: MergedFrontmatterValidator,
  fillBody?: string,
): string {
  const prepared = prepareSourceMarkdown(content);
  const { properties: frontmatter, body, eol } = prepared;
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (key === "tags") {
      frontmatter[key] = unionTags(frontmatter[key], value);
      prepared.document.set(key, frontmatter[key]);
      continue;
    }
    if (SYSTEM_KEYS.has(key) || missing(frontmatter[key])) {
      frontmatter[key] = value;
      prepared.document.set(key, value);
    }
  }

  validateMerged?.(frontmatter);

  // Text written into the note since the page was read wins over the page.
  const filled = fillBody?.trim() && !body.trim() ? `${fillBody.trim().replace(/\r?\n/g, eol)}${eol}` : undefined;
  const output = renderSourceMarkdown({ ...prepared, body: filled ?? body });
  if (filled === undefined) assertBodyPreserved(content, output);
  return output;
}

export async function applySourceFrontmatter(
  app: App,
  file: TFile,
  fm: FrontmatterData,
  validateMerged?: MergedFrontmatterValidator,
  fillBody?: string,
): Promise<void> {
  await app.vault.process(file, (current) => mergeSourceMarkdown(current, fm, validateMerged, fillBody));
}
