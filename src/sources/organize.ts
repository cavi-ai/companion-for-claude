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
  /** Relative subfolder the clip already sits in under the inbox, if any (e.g. "ai-agents"). */
  currentDomain?: string;
}

export interface OrganizeProposal {
  path: string;
  /** Folder path under the organized base, e.g. "ai-safety" or "research/continuity". */
  domain: string;
}

export interface ParsedOrganizeResponse {
  proposals: OrganizeProposal[];
  /** Candidate paths the reply never resolved — never defaulted to misc. */
  unresolved: string[];
}

const FALLBACK_DOMAIN = "misc";
const DEFAULT_CHUNK_SIZE = 16;

/** One batch call for the whole set — folder inference benefits from seeing every clip. */
export function buildOrganizePrompt(candidates: OrganizeCandidate[], existingFolders: string[]): { system: string; user: string } {
  const system =
    "You organize web clippings into a small, durable folder taxonomy. " +
    organizeRules(existingFolders);
  const user = `CLIPPINGS:\n\n${candidates.map(candidateLine).join("\n")}`;
  return { system, user };
}

/** Same batch inference for an arbitrary folder of notes (right-click organize). */
export function buildFolderOrganizePrompt(candidates: OrganizeCandidate[], existingFolders: string[]): { system: string; user: string } {
  const system =
    "You organize notes into a small, durable subfolder taxonomy. " +
    organizeRules(existingFolders);
  const user = `NOTES:\n\n${candidates.map(candidateLine).join("\n")}`;
  return { system, user };
}

function candidateLine(c: OrganizeCandidate): string {
  const currentLine = c.currentDomain ? `\n  current folder: ${c.currentDomain}` : "";
  return `- path: ${c.path}\n  title: ${c.title}\n  summary: ${c.summary}${currentLine}`;
}

function organizeRules(existingFolders: string[]): string {
  return (
    "Reply with a SINGLE JSON array and nothing else — one object per input, in the same order: " +
    `[{"path": "...", "domain": "..."}]. ` +
    "Rules: domain is 1-2 lowercase folder segments (letters, numbers, dashes; slash between segments) naming the topic or project " +
    "(e.g. \"ai-safety\", \"gardening\", \"research/continuity\"). Prefer reusing existing folders when they fit. " +
    "Group related notes under the same domain rather than inventing one per note. Use \"misc\" only when nothing fits. " +
    "When an input lists a current folder, keep it unless another folder is clearly a better fit." +
    (existingFolders.length > 0 ? `\nExisting folders to prefer when relevant:\n${existingFolders.map((f) => `- ${f}`).join("\n")}` : "")
  );
}

/** A reply array the model started but never closed — the reply was cut off, not malformed. */
function isTruncatedReply(raw: string): boolean {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = trimmed.indexOf("[");
  return start !== -1 && trimmed.lastIndexOf("]") === -1;
}

/** Parse one batch reply into proposals; a candidate the reply never names is unresolved, never misc. */
export function parseOrganizeResponse(raw: string, candidates: OrganizeCandidate[]): ParsedOrganizeResponse {
  if (isTruncatedReply(raw)) return { proposals: [], unresolved: candidates.map((c) => c.path) };

  let entries: Array<Record<string, unknown>>;
  try {
    // Models reply with a JSON array as asked (possibly fenced/prose-wrapped),
    // or (llama3.1 in the wild) a bare object for the first clip — the array
    // slice is tried first, then a single object.
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    const parsed: unknown = start !== -1 && end > start ? JSON.parse(raw.slice(start, end + 1)) : extractJson(raw);
    const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    entries = arr.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  } catch {
    return { proposals: [], unresolved: candidates.map((c) => c.path) };
  }

  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string>();
  for (const e of entries) {
    if (typeof e.path !== "string" || typeof e.domain !== "string") continue;
    const domain = sanitizeDomain(e.domain);
    byPath.set(e.path, domain);
    const basename = e.path.split("/").pop();
    if (basename && !byBasename.has(basename)) byBasename.set(basename, domain);
  }
  const positional = entries.length === candidates.length ? entries : null;

  const proposals: OrganizeProposal[] = [];
  const unresolved: string[] = [];
  candidates.forEach((c, i) => {
    let domain = byPath.get(c.path);
    if (domain === undefined) domain = byBasename.get(c.path.split("/").pop() ?? "");
    if (domain === undefined && positional) {
      const e = positional[i]!;
      if (typeof e.domain === "string") domain = sanitizeDomain(e.domain);
    }
    if (domain === undefined) unresolved.push(c.path);
    else proposals.push({ path: c.path, domain });
  });
  return { proposals, unresolved };
}

export interface InferDomainsOpts {
  existingFolders: string[];
  complete: (system: string, user: string, maxTokens: number) => Promise<string>;
  chunkSize?: number;
  /** Which prompt/rules to use — clippings (default) or an arbitrary folder of notes. */
  promptBuilder?: (candidates: OrganizeCandidate[], existingFolders: string[]) => { system: string; user: string };
}

export interface InferDomainsResult {
  proposals: OrganizeProposal[];
  unresolved: string[];
  /** At least one chunk's reply was cut off mid-array. */
  truncated: boolean;
  /** Number of batch calls made. */
  chunks: number;
  /** Message of the last `complete()` rejection, if any chunk's call threw. */
  lastError?: string;
}

/** Chunked domain inference (default 16/call); later chunks see the domains earlier chunks already chose. */
export async function inferDomains(candidates: OrganizeCandidate[], opts: InferDomainsOpts): Promise<InferDomainsResult> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const buildPrompt = opts.promptBuilder ?? buildOrganizePrompt;
  const existingFolders = [...opts.existingFolders];
  const proposals: OrganizeProposal[] = [];
  const unresolved: string[] = [];
  let truncated = false;
  let chunks = 0;
  let lastError: string | undefined;

  for (let i = 0; i < candidates.length; i += chunkSize) {
    chunks++;
    const chunk = candidates.slice(i, i + chunkSize);
    const { system, user } = buildPrompt(chunk, existingFolders);
    const maxTokens = 64 + 96 * chunk.length;
    let raw: string;
    try {
      raw = await opts.complete(system, user, maxTokens);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      for (const c of chunk) unresolved.push(c.path);
      continue;
    }
    if (isTruncatedReply(raw)) truncated = true;
    const parsed = parseOrganizeResponse(raw, chunk);
    proposals.push(...parsed.proposals);
    unresolved.push(...parsed.unresolved);
    for (const p of parsed.proposals) if (!existingFolders.includes(p.domain)) existingFolders.push(p.domain);
  }

  return { proposals, unresolved, truncated, chunks, ...(lastError !== undefined ? { lastError } : {}) };
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

/** Relative subfolder a clip sits in under the inbox, or undefined at the inbox root. */
export function currentDomainOf(path: string, inboxFolder: string): string | undefined {
  const inbox = inboxFolder.replace(/\/+$/, "");
  const prefix = `${inbox}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.lastIndexOf("/");
  return slash === -1 ? undefined : rest.slice(0, slash);
}

/** An unresolved candidate already filed under an inbox subfolder keeps that folder; a root-level one is skipped. */
export function resolveUnresolvedWithCurrentFolder(
  unresolved: string[],
  currentDomains: Map<string, string>,
): { proposals: OrganizeProposal[]; skipped: string[] } {
  const proposals: OrganizeProposal[] = [];
  const skipped: string[] = [];
  for (const path of unresolved) {
    const currentDomain = currentDomains.get(path);
    if (currentDomain) proposals.push({ path, domain: currentDomain });
    else skipped.push(path);
  }
  return { proposals, skipped };
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
