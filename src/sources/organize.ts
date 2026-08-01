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

/** Lowercase dash-separated folder path, at most 2 segments; garbage → misc. */
export function sanitizeDomain(value: string): string {
  const segments = value
    .toLowerCase()
    .split("/")
    .map((s) => s.trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
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

/**
 * Plan renames + moves: each clip lands at <base>/<domain>/<Title>.md with a
 * collision-safe name (suffix " 2", " 3", …). Clips whose basename already
 * matches the proposed title keep their name; only the folder changes.
 */
export function planOrganizeMoves(
  proposals: OrganizeProposal[],
  titles: Map<string, string>,
  opts: { baseFolder: string; taken(path: string): boolean },
): OrganizeMove[] {
  const base = opts.baseFolder.replace(/\/+$/, "");
  const reserved = new Set<string>();
  const isTaken = (path: string): boolean => reserved.has(path) || opts.taken(path);
  const out: OrganizeMove[] = [];
  for (const p of proposals) {
    const title = titles.get(p.path) ?? "";
    const dir = `${base}/${p.domain}`;
    const stem = sanitizeFileName(title || p.path.split("/").pop()?.replace(/\.md$/, "") || "Untitled");
    let name = stem;
    for (let n = 2; isTaken(`${dir}/${name}.md`) && `${dir}/${name}.md` !== p.path; n++) name = `${stem} ${n}`;
    const to = `${dir}/${name}.md`;
    if (to !== p.path) out.push({ from: p.path, to, title: title || stem, domain: p.domain });
    reserved.add(to);
  }
  return out;
}
