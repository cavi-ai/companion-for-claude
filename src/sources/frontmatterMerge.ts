import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { normalizeTags, type FrontmatterData } from "../indexing/frontmatter";
import { assertBodyPreserved } from "./enrichmentQuality";

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

function leadingFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string; eol: "\n" | "\r\n" } {
  const opening = /^---[ \t]*(\r?\n)/.exec(content);
  if (!opening) return { frontmatter: {}, body: content, eol: "\n" };

  let offset = opening[0].length;
  while (offset <= content.length) {
    const nextLf = content.indexOf("\n", offset);
    const lineEnd = nextLf === -1 ? content.length : nextLf > offset && content[nextLf - 1] === "\r" ? nextLf - 1 : nextLf;
    if (/^---[ \t]*$/.test(content.slice(offset, lineEnd))) {
      const parsed: unknown = parseYaml(content.slice(opening[0].length, offset));
      if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("leading YAML frontmatter must be a mapping");
      }
      return {
        frontmatter: (parsed ?? {}) as Record<string, unknown>,
        body: content.slice(nextLf === -1 ? lineEnd : nextLf + 1),
        eol: opening[1] === "\r\n" ? "\r\n" : "\n",
      };
    }
    if (nextLf === -1) break;
    offset = nextLf + 1;
  }
  return { frontmatter: {}, body: content, eol: "\n" };
}

/** Pure, frontmatter-only merge. Live values win; system enrichment markers deliberately refresh. */
export function mergeSourceMarkdown(
  content: string,
  fm: FrontmatterData,
  validateMerged?: MergedFrontmatterValidator,
): string {
  const { frontmatter, body, eol } = leadingFrontmatter(content);
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
