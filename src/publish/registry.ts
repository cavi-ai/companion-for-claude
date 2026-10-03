// Pure: the list of items published as gists, persisted in plugin data.

export interface PublishedItem {
  /** Vault path for a note; `artifact:<gistId>` for an artifact. */
  key: string;
  kind: "note" | "artifact";
  title: string;
  gistId: string;
  url: string;
  owner: string;
  publishedAt: number;
  updatedAt: number;
}

export const artifactKey = (gistId: string): string => `artifact:${gistId}`;

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

function parseItem(raw: unknown): PublishedItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "note" && r.kind !== "artifact") return null;
  if (!isText(r.key) || !isText(r.title) || !isText(r.gistId) || !isText(r.url) || !isText(r.owner)) return null;
  if (typeof r.publishedAt !== "number" || typeof r.updatedAt !== "number") return null;
  return { key: r.key, kind: r.kind, title: r.title, gistId: r.gistId, url: r.url, owner: r.owner, publishedAt: r.publishedAt, updatedAt: r.updatedAt };
}

export function normalizePublished(raw: unknown): PublishedItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PublishedItem[] = [];
  for (const entry of raw) {
    const item = parseItem(entry);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

export function upsertPublished(items: readonly PublishedItem[], item: PublishedItem): PublishedItem[] {
  return items.some((i) => i.key === item.key) ? items.map((i) => (i.key === item.key ? item : i)) : [...items, item];
}

export function removePublished(items: readonly PublishedItem[], key: string): PublishedItem[] {
  return items.filter((i) => i.key !== key);
}

export function renamePublished(items: readonly PublishedItem[], oldPath: string, newPath: string): PublishedItem[] {
  const moving = items.find((i) => i.kind === "note" && i.key === oldPath);
  if (!moving) return [...items];
  const occupied = items.some((i) => i.key === newPath);
  return items.flatMap((i) => (i === moving ? (occupied ? [] : [{ ...i, key: newPath }]) : [i]));
}
