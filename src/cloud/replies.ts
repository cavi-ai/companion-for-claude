// Pure, Obsidian-free core for the *reply* half of the cloud loop: read the
// notes a cloud Claude Code session wrote back into the vault's GitHub repo,
// over the GitHub Contents API (plain HTTPS — works on mobile, where there is
// no local git).
//
// Pairs with cloud/routines.ts (dispatch). A dispatched session does the work,
// writes reply notes to a folder on a branch, and opens a PR; this fetches
// those notes so they land in the vault even on a phone.

export interface RepliesConfig {
  /** "owner/name" of the vault's GitHub repo. */
  repo: string;
  /** Branch the replies live on (e.g. "main" or a claude/ branch). */
  branch: string;
  /** Folder in the repo where reply notes are written. */
  folder: string;
  /** GitHub token with Contents:read on the repo. */
  token: string;
}

export interface HttpRequestSpec {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoFile {
  name: string;
  path: string;
  sha: string;
}

export interface FetchedFile {
  path: string;
  sha: string;
  text: string;
}

const API = "https://api.github.com";

/** Split "owner/name" into its parts, or null when malformed. */
export function parseRepo(repo: string): RepoRef | null {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo.trim());
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

/** Validate replies config; returns a human-readable error, or null when OK. */
export function configError(cfg: RepliesConfig): string | null {
  if (!cfg.repo.trim()) return "No repo set — enter owner/name of your vault's GitHub repo.";
  if (!parseRepo(cfg.repo)) return "Repo must be in owner/name form (e.g. cavi-ai/my-vault).";
  if (!cfg.branch.trim()) return "No branch set for replies.";
  if (!cfg.folder.trim()) return "No replies folder set.";
  if (!cfg.token.trim()) return "No GitHub token set — needed to read replies from the repo.";
  return null;
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token.trim()}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Companion-for-Claude",
  };
}

/** Percent-encode each path segment but keep the slashes. */
function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** Build a GET for a repo path (a directory to list, or a file to read) at the branch. */
export function buildContentsRequest(cfg: RepliesConfig, path: string): HttpRequestSpec {
  const err = configError(cfg);
  if (err) throw new Error(err);
  const ref = parseRepo(cfg.repo);
  if (!ref) throw new Error("Repo must be in owner/name form (e.g. cavi-ai/my-vault).");
  const url = `${API}/repos/${ref.owner}/${ref.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch.trim())}`;
  return { url, method: "GET", headers: authHeaders(cfg.token) };
}

/** Parse a directory listing into its files. Throws an actionable error on non-2xx. */
export function parseDirListing(status: number, bodyText: string): RepoFile[] {
  if (status < 200 || status >= 300) throw new Error(githubError(status, bodyText));
  const json = safeJson(bodyText);
  if (Array.isArray(json)) {
    return json
      .map((e) => e as Record<string, unknown>)
      .filter((e) => e.type === "file")
      .map((e) => ({ name: String(e.name ?? ""), path: String(e.path ?? ""), sha: String(e.sha ?? "") }));
  }
  // A single file path returns an object, not an array.
  if (json && typeof json === "object" && (json as Record<string, unknown>).type === "file") {
    const f = json as Record<string, unknown>;
    return [{ name: String(f.name ?? ""), path: String(f.path ?? ""), sha: String(f.sha ?? "") }];
  }
  throw new Error("Unexpected Contents API response (not a directory or file).");
}

/** Parse a single file's Contents response, decoding its base64 body. */
export function parseFileResponse(status: number, bodyText: string): FetchedFile {
  if (status < 200 || status >= 300) throw new Error(githubError(status, bodyText));
  const json = safeJson(bodyText) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") throw new Error("Unexpected file response from GitHub.");
  const content = typeof json.content === "string" ? json.content : "";
  const encoding = typeof json.encoding === "string" ? json.encoding : "";
  const text = encoding === "base64" ? decodeBase64Utf8(content) : content;
  return { path: String(json.path ?? ""), sha: String(json.sha ?? ""), text };
}

export function isMarkdown(name: string): boolean {
  return /\.md$/i.test(name);
}

/** Mobile-safe base64 → UTF-8 (atob + TextDecoder; no Node Buffer). */
export function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s+/g, "");
  if (!clean) return "";
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function githubError(status: number, bodyText: string): string {
  const j = safeJson(bodyText) as { message?: string } | null;
  const detail = j?.message ? ` — ${j.message}` : "";
  switch (status) {
    case 401:
    case 403:
      return `GitHub rejected the token (${status})${detail}. Check it has Contents:read on the repo.`;
    case 404:
      return `Not found (404)${detail}. Check the repo, branch, and replies folder.`;
    default:
      return `GitHub Contents request failed (${status})${detail}.`;
  }
}
