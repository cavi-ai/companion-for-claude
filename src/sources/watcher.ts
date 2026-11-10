import { parseClipUrl } from "./detect";
import { prepareSourceMarkdown } from "./sourceMarkdown";

const SUPPORTED = new Set(["md", "csv"]);

/** Whether the note's frontmatter (not its body) carries `source_enriched: true`. */
export function isSourceEnriched(content: string): boolean {
  try { return prepareSourceMarkdown(content).properties.source_enriched === true; }
  catch { return false; } // Invalid input stays eligible so the preparation error can be shown.
}

/**
 * Nothing to enrich: a zero-byte file, or a note with no body and no source
 * URL to read one from. `content` is the note's text; other files go by size.
 */
export function isEmptySource(file: { extension: string; stat: { size: number } }, content?: string): boolean {
  if (file.extension !== "md") return file.stat.size === 0;
  if (content === undefined) return false;
  try { return !prepareSourceMarkdown(content).body.trim() && parseClipUrl(content) === undefined; }
  catch { return false; } // Invalid input stays eligible so the preparation error can be shown.
}

export interface EnrichGuardInput {
  path: string;
  ext: string;
  content: string;
  inboxFolder: string;
  recentlyWritten: Set<string>;
}

/** Pure decision: should this newly-seen file be enriched? */
export function shouldEnrich(i: EnrichGuardInput): boolean {
  if (!SUPPORTED.has(i.ext)) return false;
  const inbox = i.inboxFolder.replace(/\/+$/, "");
  if (!inbox) return false;
  if (i.path !== inbox && !i.path.startsWith(`${inbox}/`)) return false;
  if (i.recentlyWritten.has(i.path)) return false;
  if (i.ext === "md" && isSourceEnriched(i.content)) return false;
  return true;
}
