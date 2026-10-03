// Pure GitHub Gist request builders and response parsers; the caller owns the network.

export const GITHUB_API = "https://api.github.com";

export interface GistRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}

export type GistOp = "create" | "update" | "delete" | "test";

export type GistOutcome =
  | { kind: "ok"; id: string; url: string; owner: string }
  | { kind: "gone" }
  | { kind: "error"; message: string };

const baseOf = (base: string): string => (base || GITHUB_API).replace(/\/+$/, "");

function headers(token: string, json: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

const fileBody = (files: Record<string, string>): Record<string, { content: string }> =>
  Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }]));

export function createGistRequest(base: string, token: string, files: Record<string, string>, description: string): GistRequest {
  return {
    url: `${baseOf(base)}/gists`,
    method: "POST",
    headers: headers(token, true),
    body: JSON.stringify({ description, public: false, files: fileBody(files) }),
  };
}

export function updateGistRequest(base: string, token: string, id: string, files: Record<string, string>): GistRequest {
  return {
    url: `${baseOf(base)}/gists/${id}`,
    method: "PATCH",
    headers: headers(token, true),
    body: JSON.stringify({ files: fileBody(files) }),
  };
}

export function deleteGistRequest(base: string, token: string, id: string): GistRequest {
  return { url: `${baseOf(base)}/gists/${id}`, method: "DELETE", headers: headers(token, false) };
}

export function testTokenRequest(base: string, token: string): GistRequest {
  return { url: `${baseOf(base)}/gists?per_page=1`, method: "GET", headers: headers(token, false) };
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseGistResponse(status: number, json: unknown, op: GistOp): GistOutcome {
  const body = asRecord(json);
  if (status === 401) return { kind: "error", message: "GitHub rejected the token." };
  if (status === 404 && (op === "update" || op === "delete")) return { kind: "gone" };
  if ((status === 403 || status === 404) && (op === "create" || op === "test")) {
    return { kind: "error", message: "This token can't create gists — give it Gists: read and write." };
  }
  if (status === 403 || status === 404) {
    return { kind: "error", message: "This token can't change gists — give it Gists: read and write." };
  }
  const message = typeof body.message === "string" ? body.message : "";
  if (status === 422) return { kind: "error", message: message || "GitHub rejected the request." };
  if (status < 200 || status >= 300) return { kind: "error", message: `GitHub returned ${status}${message ? `: ${message}` : "."}` };
  if (op === "delete" || op === "test") return { kind: "ok", id: "", url: "", owner: "" };
  const id = body.id;
  const url = body.html_url;
  const owner = asRecord(body.owner).login;
  if (typeof id !== "string" || !id || typeof url !== "string" || typeof owner !== "string") {
    return { kind: "error", message: "GitHub returned an unexpected response." };
  }
  return { kind: "ok", id, url, owner };
}

export function githackUrl(owner: string, id: string, file: string): string {
  return `https://gist.githack.com/${owner}/${id}/raw/${file}`;
}
