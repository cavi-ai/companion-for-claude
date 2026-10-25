import { prepareSourceMarkdown } from "./sourceMarkdown";

const SUPPORTED = new Set(["md", "csv"]);

/** Whether the note's frontmatter (not its body) carries `source_enriched: true`. */
export function isSourceEnriched(content: string): boolean {
  try { return prepareSourceMarkdown(content).properties.source_enriched === true; }
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
