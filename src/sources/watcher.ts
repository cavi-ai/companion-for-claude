const SUPPORTED = new Set(["md", "csv"]);

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
  if (i.ext === "md" && /^source_enriched:\s*true\s*$/m.test(i.content)) return false;
  return true;
}
