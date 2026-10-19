// Provenance for chat replies: the notes and sections a reply cites as
// wikilinks, each checked against the vault. Pure; vault access is injected.

/** How a reply should cite a vault note; shared by the context and agent prompts. */
export const CITATION_FORM =
  "an Obsidian wikilink to the note's file name, without the folder path or .md extension: " +
  "[[Note Name]], or [[Note Name#Heading]] when it comes from one section";

/** One note (and optional section) a reply cites. */
export interface Citation {
  linkpath: string;
  heading: string | null;
}

/** found: the note (and section) exist; no-section: the note exists without that heading; missing: no note resolves. */
export type CitationStatus = "found" | "no-section" | "missing";

export interface CheckedCitation extends Citation {
  status: CitationStatus;
  /** Vault path the link resolves to, or null. */
  path: string | null;
  /** Opening text of the cited section, when it exists. */
  excerpt: string | null;
}

export interface CitationVault {
  /** Vault path a link resolves to, or null. */
  resolve(linkpath: string): string | null;
  read(path: string): Promise<string>;
}

const EXCERPT_CHARS = 160;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

/** Strip fenced code blocks and inline code so links inside code are not citations. */
function withoutCode(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    lines.push(line.replace(/`[^`\n]*`/g, ""));
  }
  return lines.join("\n");
}

/** Wikilinks a reply cites, in first-seen order, one per note and section; embeds and code are skipped. */
export function extractCitations(markdown: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const match of withoutCode(markdown).matchAll(WIKILINK)) {
    if (match[1]) continue;
    const target = match[2]!.split("|")[0]!;
    const hash = target.indexOf("#");
    const linkpath = (hash < 0 ? target : target.slice(0, hash)).trim();
    const anchor = hash < 0 ? "" : target.slice(hash + 1).trim();
    if (!linkpath) continue;
    const heading = anchor && !anchor.startsWith("^") ? anchor : null;
    const key = `${linkpath.toLowerCase()}#${heading?.toLowerCase() ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ linkpath, heading });
  }
  return out;
}

/** Heading text as Obsidian matches it in a link: case- and punctuation-insensitive. */
function headingKey(text: string): string {
  return text.replace(/[#|^:%[\]\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Opening text of the section under `heading` (last segment of a nested anchor), or null when the note has no such heading. */
export function sectionExcerpt(note: string, heading: string): string | null {
  const wanted = headingKey(heading.split("#").pop() ?? heading);
  const lines = note.split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }
  let fence: string | null = null;
  let collecting = false;
  const text: string[] = [];
  for (const line of lines.slice(start)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
      continue;
    }
    if (fence) continue;
    const title = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (title !== undefined) {
      if (collecting) break;
      collecting = headingKey(title) === wanted;
      continue;
    }
    if (collecting && line.trim()) text.push(line.trim());
  }
  if (!collecting) return null;
  const joined = text.join(" ").replace(/\s+/g, " ");
  return joined.length > EXCERPT_CHARS ? `${joined.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : joined;
}

/** Check each citation against the vault: does the note resolve, and does the cited section exist. */
export async function checkCitations(citations: Citation[], vault: CitationVault): Promise<CheckedCitation[]> {
  return Promise.all(citations.map(async (citation): Promise<CheckedCitation> => {
    const path = vault.resolve(citation.linkpath);
    if (!path) return { ...citation, status: "missing", path: null, excerpt: null };
    if (!citation.heading) return { ...citation, status: "found", path, excerpt: null };
    const excerpt = path.endsWith(".md") ? sectionExcerpt(await vault.read(path), citation.heading) : null;
    return excerpt === null
      ? { ...citation, status: "no-section", path, excerpt: null }
      : { ...citation, status: "found", path, excerpt };
  }));
}
