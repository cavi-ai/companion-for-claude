// Decide which inbox files still need enrichment — the data behind the
// source-inbox triage view. Obsidian-free so it can be unit-tested.

import type { SourceType } from "./types";

export interface InboxFileEntry {
  path: string;
  basename: string;
  ext: string;
  frontmatter?: Record<string, unknown> | undefined;
  mtime?: number | undefined;
}

export interface InboxItem {
  path: string;
  basename: string;
  ext: string;
  type: SourceType;
}

const SUPPORTED = new Set(["md", "csv"]);
const TYPES = new Set(["article", "video", "dataset"]);

function itemType(e: InboxFileEntry): SourceType {
  if (e.ext !== "md") return "dataset";
  const fm = e.frontmatter ?? {};
  const stamped = fm.type;
  if (typeof stamped === "string" && TYPES.has(stamped)) return stamped as SourceType;
  const raw = fm.source ?? fm.url;
  const url = typeof raw === "string" ? raw : "";
  if (/(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts)/i.test(url)) return "video";
  return "article";
}

/** Unenriched inbox files: md clips without the marker, data files without a sidecar. */
export function inboxItems(entries: InboxFileEntry[], inboxFolder: string): InboxItem[] {
  const inbox = inboxFolder.replace(/\/+$/, "");
  if (!inbox) return [];
  const inInbox = entries.filter((e) => SUPPORTED.has(e.ext) && e.path !== inbox && e.path.startsWith(`${inbox}/`));

  const enrichedAssets = new Set<string>();
  for (const e of inInbox) {
    if (e.ext === "md" && e.frontmatter?.source_enriched === true && typeof e.frontmatter.asset === "string") {
      enrichedAssets.add(e.frontmatter.asset);
    }
  }

  const items: InboxItem[] = [];
  for (const e of inInbox) {
    if (e.ext === "md") {
      if (e.frontmatter?.source_enriched === true) continue;
    } else if (enrichedAssets.has(e.path)) {
      continue;
    }
    items.push({ path: e.path, basename: e.basename, ext: e.ext, type: itemType(e) });
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

/** Already-typed inbox clips, newest first — auto-enrich leaves no other trace. */
export function typedInboxItems(entries: InboxFileEntry[], inboxFolder: string, limit = 10): InboxItem[] {
  const inbox = inboxFolder.replace(/\/+$/, "");
  if (!inbox) return [];
  return entries
    .filter((e) => e.ext === "md" && e.path.startsWith(`${inbox}/`) && e.frontmatter?.source_enriched === true)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((e) => ({ path: e.path, basename: e.basename, ext: e.ext, type: itemType(e) }));
}
