// Provenance for chat replies: the notes and sections a reply cites as
// wikilinks, each checked against the vault. Pure; vault access is injected.

/** How a reply should cite a vault note; shared by the context and agent prompts. */
export const CITATION_FORM =
  "an Obsidian wikilink using the full vault-relative path shown in the source, including its folders and .md extension: " +
  "[[Folder/Note Name.md]], or [[Folder/Note Name.md#Heading]] when it comes from one section; do not shorten the path to a shared file name";

/** Qualified paths identify a file exactly; legacy short names must have one match. */
export function resolveCitationPath(linkpath: string, paths: readonly string[]): { path: string | null; ambiguous: boolean } {
  const key = (path: string) => path.replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
  const wanted = key(linkpath);
  const qualified = linkpath.includes("/") || /\.md$/i.test(linkpath);
  const matches = paths.filter(path => (qualified ? key(path) : key(path).split("/").pop()) === wanted);
  return { path: matches.length === 1 ? matches[0]! : null, ambiguous: matches.length > 1 };
}

/** One note (and optional section) a reply cites. */
export interface Citation {
  linkpath: string;
  heading: string | null;
}

/** The source resolved when an answer was saved; independent of its historical wording. */
export interface CitationTarget extends Citation {
  path: string | null;
}

export function currentCitationTargets(raw: unknown): CitationTarget[] | undefined {
  if (!Array.isArray(raw) || !raw.every((value: unknown): value is CitationTarget => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.linkpath === "string" && (item.heading === null || typeof item.heading === "string") && (item.path === null || typeof item.path === "string");
  })) return undefined;
  return raw.map(({ linkpath, heading, path }) => ({ linkpath, heading, path }));
}

export function renameCitationTargets(targets: CitationTarget[] | undefined, oldPath: string, newPath: string): CitationTarget[] | undefined {
  if (!targets) return targets;
  let changed = false;
  const next = targets.map(target => {
    if (target.path !== oldPath && !target.path?.startsWith(`${oldPath}/`)) return target;
    changed = true;
    return { ...target, path: newPath + target.path.slice(oldPath.length) };
  });
  return changed ? next : targets;
}

/** A deleted source must not reconnect to a different file that later reuses its path. */
export function invalidateCitationTargets(targets: CitationTarget[] | undefined, deletedPath: string): CitationTarget[] | undefined {
  if (!targets) return targets;
  let changed = false;
  const next = targets.map(target => {
    if (target.path !== deletedPath && !target.path?.startsWith(`${deletedPath}/`)) return target;
    changed = true;
    return { ...target, path: null };
  });
  return changed ? next : targets;
}

/** found: source exists; no-section: heading is absent; missing: no source; ambiguous: several notes share the name. */
export type CitationStatus = "found" | "no-section" | "missing" | "ambiguous";

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
  /** A short name that matches several notes is not an identified source. */
  ambiguous?(linkpath: string): boolean;
  read(path: string): Promise<string>;
}

const EXCERPT_CHARS = 160;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

/** Mask code without changing offsets, so citation edits preserve the original Markdown. */
function withoutCode(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  const mask = (text: string) => " ".repeat(text.length);
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      lines.push(mask(line));
      continue;
    }
    if (marker) {
      fence = marker;
      lines.push(mask(line));
      continue;
    }
    lines.push(line.replace(/(`+)(?!`)([^`]|(?!\1)`)*?\1(?!`)/g, mask));
  }
  return lines.join("\n");
}

/** Resolve exported links at action time; never change the stored conversation or code examples. */
export function exportCitationLinks(markdown: string, targets: readonly CitationTarget[]): string {
  let result = "";
  let offset = 0;
  for (const match of withoutCode(markdown).matchAll(WIKILINK)) {
    if (match[1]) continue;
    const citation = extractCitations(match[0])[0];
    if (!citation) continue;
    const target = targets.find(item => item.linkpath.toLowerCase() === citation.linkpath.toLowerCase() && item.heading?.toLowerCase() === citation.heading?.toLowerCase());
    if (!target) continue;
    const raw = match[2]!;
    const pipe = raw.indexOf("|");
    const destination = pipe < 0 ? raw : raw.slice(0, pipe);
    const hash = destination.indexOf("#");
    const alias = pipe < 0 ? "" : raw.slice(pipe);
    const replacement = target.path
      ? `[[${target.path}${hash < 0 ? "" : destination.slice(hash)}${alias}]]`
      : `${(alias ? alias.slice(1) : destination).replace(/[\\`*_{}[\]<>!|]/g, "\\$&")} (source unavailable)`;
    result += markdown.slice(offset, match.index) + replacement;
    offset = match.index + match[0].length;
  }
  return result + markdown.slice(offset);
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
    if (!path) return { ...citation, status: vault.ambiguous?.(citation.linkpath) ? "ambiguous" : "missing", path: null, excerpt: null };
    if (!citation.heading) return { ...citation, status: "found", path, excerpt: null };
    const excerpt = path.endsWith(".md") ? sectionExcerpt(await vault.read(path), citation.heading) : null;
    return excerpt === null
      ? { ...citation, status: "no-section", path, excerpt: null }
      : { ...citation, status: "found", path, excerpt };
  }));
}
