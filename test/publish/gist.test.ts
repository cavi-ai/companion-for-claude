import { describe, expect, it } from "vitest";
import {
  GITHUB_API,
  createGistRequest,
  deleteGistRequest,
  githackUrl,
  parseGistResponse,
  testTokenRequest,
  updateGistRequest,
} from "../../src/publish/gist";

const HEADERS = {
  authorization: "Bearer tok",
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

describe("gist requests", () => {
  it("creates a secret gist", () => {
    const req = createGistRequest(GITHUB_API, "tok", { "note.md": "# hi" }, "My note");
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.github.com/gists");
    expect(req.headers).toMatchObject(HEADERS);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body!)).toEqual({ description: "My note", public: false, files: { "note.md": { content: "# hi" } } });
  });

  it("updates by id without touching visibility", () => {
    const req = updateGistRequest("http://127.0.0.1:9", "tok", "abc", { "note.md": "v2" });
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("http://127.0.0.1:9/gists/abc");
    expect(req.headers).toMatchObject(HEADERS);
    expect(JSON.parse(req.body!)).toEqual({ files: { "note.md": { content: "v2" } } });
  });

  it("deletes by id with no body", () => {
    const req = deleteGistRequest(GITHUB_API, "tok", "abc");
    expect(req).toMatchObject({ method: "DELETE", url: "https://api.github.com/gists/abc", headers: HEADERS });
    expect(req.body).toBeUndefined();
  });

  it("tests the token with a one-item listing", () => {
    expect(testTokenRequest(GITHUB_API, "tok")).toMatchObject({ method: "GET", url: "https://api.github.com/gists?per_page=1", headers: HEADERS });
  });

  it("falls back to the GitHub API when the base is empty", () => {
    expect(createGistRequest("", "t", {}, "d").url).toBe("https://api.github.com/gists");
  });
});

describe("parseGistResponse", () => {
  const created = { id: "g1", html_url: "https://gist.github.com/me/g1", owner: { login: "me" } };

  it("reads id, url, and owner on create and update", () => {
    expect(parseGistResponse(201, created, "create")).toEqual({ kind: "ok", id: "g1", url: "https://gist.github.com/me/g1", owner: "me" });
    expect(parseGistResponse(200, created, "update")).toMatchObject({ kind: "ok", id: "g1" });
  });

  it("rejects a success body without an id", () => {
    expect(parseGistResponse(201, {}, "create")).toEqual({ kind: "error", message: "GitHub returned an unexpected response." });
  });

  it("accepts delete and test successes", () => {
    expect(parseGistResponse(204, null, "delete").kind).toBe("ok");
    expect(parseGistResponse(200, [], "test").kind).toBe("ok");
  });

  it("maps 401 to a rejected token on every operation", () => {
    for (const op of ["create", "update", "delete", "test"] as const) {
      expect(parseGistResponse(401, { message: "Bad credentials" }, op)).toEqual({ kind: "error", message: "GitHub rejected the token." });
    }
  });

  it("maps 403 and 404 on create and test to the permission hint", () => {
    const message = "This token can't create gists — give it Gists: read and write.";
    expect(parseGistResponse(403, {}, "create")).toEqual({ kind: "error", message });
    expect(parseGistResponse(404, {}, "create")).toEqual({ kind: "error", message });
    expect(parseGistResponse(403, {}, "test")).toEqual({ kind: "error", message });
  });

  it("reports a missing gist on update and delete as gone", () => {
    expect(parseGistResponse(404, {}, "update")).toEqual({ kind: "gone" });
    expect(parseGistResponse(404, {}, "delete")).toEqual({ kind: "gone" });
  });

  it("surfaces GitHub's message on 422", () => {
    expect(parseGistResponse(422, { message: "Validation Failed" }, "create")).toEqual({ kind: "error", message: "Validation Failed" });
  });

  it("names the status for anything else", () => {
    expect(parseGistResponse(500, null, "create")).toEqual({ kind: "error", message: "GitHub returned 500." });
    expect(parseGistResponse(502, { message: "Bad gateway" }, "update")).toEqual({ kind: "error", message: "GitHub returned 502: Bad gateway" });
  });
});

describe("githackUrl", () => {
  it("builds the rendered-html link", () => {
    expect(githackUrl("me", "g1", "index.html")).toBe("https://gist.githack.com/me/g1/raw/index.html");
  });
});
