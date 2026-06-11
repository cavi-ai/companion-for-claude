// Pure (Obsidian-free) logic for the "@" context picker: building the candidate
// list, filtering it, and detecting the active @-token at the cursor. The view
// (AtMenu) and ChatView wire these to the editor + context-gathering.

export type AtKind = "note" | "selection" | "linked" | "vault" | "note-path" | "folder-path";

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

/** The four "special" context sources, always offered first. */
export const AT_SPECIALS: ReadonlyArray<AtItem> = [
  { id: "note", kind: "note", label: "This note", sublabel: "the active note" },
  { id: "selection", kind: "selection", label: "Selection", sublabel: "your highlighted text" },
  { id: "linked", kind: "linked", label: "Linked notes", sublabel: "notes linked to/from this one" },
  { id: "vault", kind: "vault", label: "Entire vault", sublabel: "semantic + keyword search" },
];

/** Build the full candidate list: specials, then notes, then folders. */
export function buildAtItems(notePaths: string[], folderPaths: string[]): AtItem[] {
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
  return [...AT_SPECIALS, ...notes, ...folders];
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
  const upto = text.slice(0, cursor);
  const at = upto.lastIndexOf("@");
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
