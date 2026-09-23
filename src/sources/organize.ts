// Clipping organizer: propose a domain/project folder per enriched clip from
// its title + summary, and plan collision-safe rename+move operations. Pure —
// the model call, vault scan, and renames are wired in main.ts; tests drive
// the prompt, parsing, and move planning directly.

import { extractJson } from "./validate";
import { sanitizeFileName } from "../artifacts/parse";

export interface OrganizeCandidate {
  path: string;
  title: string;
  summary: string;
}

export interface OrganizeProposal {
  path: string;
  /** Folder path under the organized base, e.g. "ai-safety" or "research/continuity". */
  domain: string;
}

const FALLBACK_DOMAIN = "misc";

/** One batch call for the whole set — folder inference benefits from seeing every clip. */
export function buildOrganizePrompt(candidates: OrganizeCandidate[], existingFolders: string[]): { system: string; user: string } {
  const system =
    "You organize web clippings into a small, durable folder taxonomy. " +
    organizeRules(existingFolders);
  const user = `CLIPPINGS:\n\n${candidates.map((c) => `- path: ${c.path}\n  title: ${c.title}\n  summary: ${c.summary}`).join("\n")}`;
  return { system, user };
}

/** Same batch inference for an arbitrary folder of notes (right-click organize). */
export function buildFolderOrganizePrompt(candidates: OrganizeCandidate[], existingFolders: string[]): { system: string; user: string } {
  const system =
    "You organize notes into a small, durable subfolder taxonomy. " +
    organizeRules(existingFolders);
  const user = `NOTES:\n\n${candidates.map((c) => `- path: ${c.path}\n  title: ${c.title}\n  summary: ${c.summary}`).join("\n")}`;
  return { system, user };
}

function organizeRules(existingFolders: string[]): string {
  return (
    "Reply with a SINGLE JSON array and nothing else — one object per input, in the same order: " +
    `[{"path": "...", "domain": "..."}]. ` +
    "Rules: domain is 1-2 lowercase folder segments (letters, numbers, dashes; slash between segments) naming the topic or project " +
    "(e.g. \"ai-safety\", \"gardening\", \"research/continuity\"). Prefer reusing existing folders when they fit. " +
    "Group related notes under the same domain rather than inventing one per note. Use \"misc\" only when nothing fits." +
    (existingFolders.length > 0 ? `\nExisting folders to prefer when relevant:\n${existingFolders.map((f) => `- ${f}`).join("\n")}` : "")
  );
}

/** Parse the batch reply into proposals, one per candidate (unmatched → misc). */
export function parseOrganizeResponse(raw: string, candidates: OrganizeCandidate[]): OrganizeProposal[] {
  const byPath = new Map<string, string>();
  try {
    // Models reply with a JSON array as asked (possibly fenced/prose-wrapped),
    // or (llama3.1 in the wild) a bare object for the first clip — the array
    // slice is tried first, then a single object.
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    const parsed: unknown = start !== -1 && end > start ? JSON.parse(raw.slice(start, end + 1)) : extractJson(raw);
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.path === "string" && typeof e.domain === "string") byPath.set(e.path, sanitizeDomain(e.domain));
    }
  } catch {
    // Whole batch falls back to misc — the review modal still lets the user fix folders.
  }
  return candidates.map((c) => ({ path: c.path, domain: byPath.get(c.path) ?? FALLBACK_DOMAIN }));
}

/** Parent paths under `${base}/`, made relative to base, sorted and deduped. */
export function relativeFolders(parentPaths: string[], base: string): string[] {
  const prefix = `${base}/`;
  const out = new Set<string>();
  for (const p of parentPaths) {
    if (p.startsWith(prefix) && p.length > prefix.length) out.add(p.slice(prefix.length));
  }
  return [...out].sort();
}

/** Lowercase dash-separated folder path, at most 2 segments; garbage → misc. */
export function sanitizeDomain(value: string): string {
  const segments = value
    .split("/")
    .map(sanitizeSegment)
    .filter(Boolean)
    .slice(0, 2);
  return segments.length > 0 ? segments.join("/") : FALLBACK_DOMAIN;
}

export interface OrganizeMove {
  from: string;
  to: string;
  title: string;
  domain: string;
}

/** Same per-segment normalization sanitizeDomain applies before joining. */
function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every prefix of every existing folder, keyed by its sanitized path, mapped to its own spelling. */
function existingPrefixesBySanitizedPath(existingFolders: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const folder of [...existingFolders].sort()) {
    const rawSegments = folder.split("/").filter(Boolean);
    const sanitizedPrefix: string[] = [];
    const rawPrefix: string[] = [];
    for (const seg of rawSegments) {
      sanitizedPrefix.push(sanitizeSegment(seg));
      rawPrefix.push(seg);
      const key = sanitizedPrefix.join("/");
      if (!out.has(key)) out.set(key, rawPrefix.join("/"));
    }
  }
  return out;
}

/** Reuse an existing folder's spelling per segment so "ai/x" never creates a case-only sibling of "AI". */
function canonicalizeDomain(domain: string, existingPrefixes: Map<string, string>): string {
  const segments = domain.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const key = segments.slice(0, i + 1).join("/");
    const match = existingPrefixes.get(key);
    out.push(match ? match.split("/")[match.split("/").length - 1]! : segments[i]!);
  }
  return out.join("/");
}

/**
 * Plan renames + moves: each clip lands at <base>/<domain>/<Title>.md with a
 * collision-safe name (suffix " 2", " 3", …). Clips whose basename already
 * matches the proposed title keep their name; only the folder changes.
 */
export function planOrganizeMoves(
  proposals: OrganizeProposal[],
  titles: Map<string, string>,
  opts: { baseFolder: string; taken(path: string): boolean; existingFolders?: string[] },
): OrganizeMove[] {
  const base = opts.baseFolder.replace(/\/+$/, "");
  const existingPrefixes = existingPrefixesBySanitizedPath(opts.existingFolders ?? []);
  const reserved = new Set<string>();
  const isTaken = (path: string): boolean => reserved.has(path) || opts.taken(path);
  const out: OrganizeMove[] = [];
  for (const p of proposals) {
    const title = titles.get(p.path) ?? "";
    const domain = canonicalizeDomain(p.domain, existingPrefixes);
    const dir = `${base}/${domain}`;
    const stem = sanitizeFileName(title || p.path.split("/").pop()?.replace(/\.md$/, "") || "Untitled");
    let name = stem;
    for (let n = 2; isTaken(`${dir}/${name}.md`) && `${dir}/${name}.md` !== p.path; n++) name = `${stem} ${n}`;
    const to = `${dir}/${name}.md`;
    if (to !== p.path) out.push({ from: p.path, to, title: title || stem, domain });
    reserved.add(to);
  }
  return out;
}
