import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import { assertBodyPreserved } from "./enrichmentQuality";
import { frontmatterBlock } from "../markdown/frontmatter";

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
  const block = frontmatterBlock(content);
  if (!block) return {};
  const message = "Invalid YAML properties. Open the note and fix its opening YAML properties block, then retry. The note was not changed.";
  let parsed: unknown;
  try {
    parsed = parseYaml(block.yaml);
  } catch {
    throw new Error(message);
  }
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(message);
  }
  return (parsed ?? {}) as Record<string, unknown>;
}

/** Pure, frontmatter-only merge. Live values win; system enrichment markers deliberately refresh. */
export function mergeSourceMarkdown(
  content: string,
  fm: FrontmatterData,
  validateMerged?: MergedFrontmatterValidator,
): string {
  const frontmatter = sourceProperties(content);
  const block = frontmatterBlock(content);
  const body = block ? content.slice(block.end) : content;
  const eol = block?.eol ?? "\n";
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (key === "tags") {
      frontmatter[key] = unionTags(frontmatter[key], value);
      continue;
    }
    if (SYSTEM_KEYS.has(key) || missing(frontmatter[key])) frontmatter[key] = value;
  }

  validateMerged?.(frontmatter);

  const yaml = stringifyYaml(frontmatter).replace(/\r?\n$/, "").replace(/\r?\n/g, eol);
  const output = `---${eol}${yaml}${yaml ? eol : ""}---${eol}${body}`;
  assertBodyPreserved(content, output);
  return output;
}

export async function applySourceFrontmatter(
  app: App,
  file: TFile,
  fm: FrontmatterData,
  validateMerged?: MergedFrontmatterValidator,
): Promise<void> {
  await app.vault.process(file, (current) => mergeSourceMarkdown(current, fm, validateMerged));
}
