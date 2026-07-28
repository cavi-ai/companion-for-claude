// Post-ingestion graph wiring: which enriched inbox notes still mention other
// notes without linking them. The data behind the inbox view's "wire up"
// section — ingestion shouldn't end in a drawer. Pure, unit-testable.

import type { InboxFileEntry } from "../sources/inbox";
import { findUnlinkedMentions, type LinkCandidate } from "./unlinkedMentions";

export interface WireUpItem {
  path: string;
  basename: string;
  /** Unlinked mentions of other notes (capped by findUnlinkedMentions). */
  mentionCount: number;
}

export interface WireUpEntry extends InboxFileEntry {
  /** Full note content (mention scanning needs the body, not just frontmatter). */
  content: string;
}

/**
 * Enriched inbox notes (markdown only — sidecar notes are already typed and
 * carry little prose) that contain at least one unlinked mention, most-linked
 * first. The cap keeps a huge inbox from turning the section into a wall.
 */
export function wireUpItems(entries: WireUpEntry[], candidates: LinkCandidate[], inboxFolder: string, limit = 25): WireUpItem[] {
  const inbox = inboxFolder.replace(/\/+$/, "");
  if (!inbox) return [];
  const items: WireUpItem[] = [];
  for (const e of entries) {
    if (e.ext !== "md") continue;
    if (e.path === inbox || !e.path.startsWith(`${inbox}/`)) continue;
    if (e.frontmatter?.source_enriched !== true) continue;
    const mentions = findUnlinkedMentions(e.content, candidates, e.path);
    if (mentions.length > 0) items.push({ path: e.path, basename: e.basename, mentionCount: mentions.length });
  }
  return items.sort((a, b) => b.mentionCount - a.mentionCount || a.path.localeCompare(b.path)).slice(0, limit);
}
