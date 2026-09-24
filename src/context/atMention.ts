// Pure (Obsidian-free) logic for the "@" context picker: building the candidate
// list, filtering it, and detecting the active @-token at the cursor. The view
// (AtMenu) and ChatView wire these to the editor + context-gathering.

export type AtKind = "note" | "selection" | "linked" | "vault" | "note-path" | "folder-path" | "media-path" | "base-path" | "claim" | "recent" | "project";

export interface AtItem {
  /** Stable id (kind, or kind:path). */
  id: string;
  kind: AtKind;
  /** Display label. */
  label: string;
  /** Secondary text (e.g. the path). */
  sublabel?: string;
  /** Vault path for note-path / folder-path items. */
  path?: string;
}

/** A research claim as offered to the "@"/"#" pickers. */
export interface ClaimAtSource {
  path: string;
  label: string;
  project: string;
}

/** A chat project as offered to the "@" picker. */
export interface ProjectAtSource {
  id: string;
  name: string;
}

/** The four "special" context sources, always offered first. */
export const AT_SPECIALS: ReadonlyArray<AtItem> = [
  { id: "note", kind: "note", label: "This note", sublabel: "the active note" },
  { id: "selection", kind: "selection", label: "Selection", sublabel: "your highlighted text" },
  { id: "linked", kind: "linked", label: "Linked notes", sublabel: "notes linked to/from this one" },
  { id: "vault", kind: "vault", label: "Entire vault", sublabel: "semantic + keyword search" },
];

/** Recent-file items: same shape as a note attach, labeled "Recent · <name>". */
function buildRecentItems(recentPaths: string[]): AtItem[] {
  return recentPaths.map((p) => ({
    id: `recent:${p}`,
    kind: "recent",
    label: `Recent · ${basename(p)}`,
    sublabel: p,
    path: p,
  }));
}

/** `.base` file items, labeled "<name>.base". */
function buildBaseItems(basePaths: string[]): AtItem[] {
  return basePaths.map((p) => ({
    id: `base-path:${p}`,
    kind: "base-path",
    label: basename(p),
    sublabel: p,
    path: p,
  }));
}

/** Research-claim items: label is the claim text (trimmed), sublabel is its project. */
export function buildClaimItems(claims: ClaimAtSource[]): AtItem[] {
  return claims.map((c) => ({
    id: `claim:${c.path}`,
    kind: "claim",
    label: trimLabel(c.label, 80),
    sublabel: c.project,
    path: c.path,
  }));
}

/** Chat-project items, badged "project", offered right after the specials. */
function buildProjectItems(projects: ProjectAtSource[]): AtItem[] {
  return projects.map((p) => ({
    id: `project:${p.id}`,
    kind: "project",
    label: p.name,
    sublabel: "project",
    path: p.id,
  }));
}

/** Build the full candidate list: specials, projects, recents, notes, folders, bases, claims, media. */
export function buildAtItems(
  notePaths: string[],
  folderPaths: string[],
  mediaPaths: string[] = [],
  basePaths: string[] = [],
  claims: ClaimAtSource[] = [],
  recentPaths: string[] = [],
  projects: ProjectAtSource[] = [],
): AtItem[] {
  const notes: AtItem[] = notePaths.map((p) => ({
    id: `note-path:${p}`,
    kind: "note-path",
    label: basename(p),
    sublabel: p,
    path: p,
  }));
  const folders: AtItem[] = folderPaths.map((p) => ({
    id: `folder-path:${p}`,
    kind: "folder-path",
    label: `${basename(p)}/`,
    sublabel: p,
    path: p,
  }));
  const media: AtItem[] = mediaPaths.map((p) => ({
    id: `media-path:${p}`,
    kind: "media-path",
    label: basename(p),
    sublabel: p,
    path: p,
  }));
  return [...AT_SPECIALS, ...buildProjectItems(projects), ...buildRecentItems(recentPaths), ...notes, ...folders, ...buildBaseItems(basePaths), ...buildClaimItems(claims), ...media];
}

/**
 * Filter @-items by query. Empty query → specials + a slice of everything.
 * Otherwise case-insensitive substring on label + sublabel, specials first.
 */
export function filterAtItems(items: AtItem[], query: string, limit = 12): AtItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return items.slice(0, limit);
  }
  const matches = items.filter((it) => {
    const hay = `${it.label} ${it.sublabel ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
  // Specials that match stay on top (they already lead the array).
  return matches.slice(0, limit);
}

/**
 * Detect an active "@" token ending at `cursor`. The "@" must start the text or
 * follow whitespace. The query runs from just after "@" to the cursor and may
 * contain spaces (note names do), but not a newline. Returns null if none.
 */
export function activeAtQuery(text: string, cursor: number): { query: string; start: number } | null {
  return activeTokenQuery(text, cursor, "@");
}

/**
 * Same rules as `activeAtQuery`, for "#" instead of "@". Used for the
 * claims-only picker: "#" must start the text or follow whitespace, and its
 * query cannot contain a newline.
 */
export function activeHashQuery(text: string, cursor: number): { query: string; start: number } | null {
  return activeTokenQuery(text, cursor, "#");
}

function activeTokenQuery(text: string, cursor: number, trigger: string): { query: string; start: number } | null {
  const upto = text.slice(0, cursor);
  const at = upto.lastIndexOf(trigger);
  if (at === -1) return null;
  // Must be at start or preceded by whitespace.
  if (at > 0 && !/\s/.test(text.charAt(at - 1))) return null;
  const query = upto.slice(at + 1);
  if (query.includes("\n")) return null;
  return { query, start: at };
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  const name = i === -1 ? path : path.slice(i + 1);
  return name.replace(/\.md$/i, "");
}

function trimLabel(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
