import { describe, it, expect } from "vitest";
import {
  parseRepo,
  configError,
  buildContentsRequest,
  parseDirListing,
  parseFileResponse,
  isMarkdown,
  decodeBase64Utf8,
  type RepliesConfig,
} from "../src/cloud/replies";

const ok: RepliesConfig = {
  repo: "cavi-ai/my-vault",
  branch: "main",
  folder: "Claude/Replies",
  token: "ghp_secret",
};

describe("parseRepo", () => {
  it("splits owner/name", () => {
    expect(parseRepo("cavi-ai/my-vault")).toEqual({ owner: "cavi-ai", name: "my-vault" });
  });
  it("rejects malformed values", () => {
    expect(parseRepo("just-a-name")).toBeNull();
    expect(parseRepo("a/b/c")).toBeNull();
    expect(parseRepo("")).toBeNull();
  });
});

describe("configError", () => {
  it("passes a complete config", () => {
    expect(configError(ok)).toBeNull();
  });
  it("requires repo / branch / folder / token", () => {
    expect(configError({ ...ok, repo: "" })).toMatch(/repo/i);
    expect(configError({ ...ok, repo: "bad" })).toMatch(/owner\/name/i);
    expect(configError({ ...ok, branch: "" })).toMatch(/branch/i);
    expect(configError({ ...ok, folder: "" })).toMatch(/folder/i);
    expect(configError({ ...ok, token: "" })).toMatch(/token/i);
  });
});

describe("buildContentsRequest", () => {
  it("builds a GET at the branch with auth headers", () => {
    const req = buildContentsRequest(ok, "Claude/Replies");
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.github.com/repos/cavi-ai/my-vault/contents/Claude/Replies?ref=main");
    expect(req.headers.authorization).toBe("Bearer ghp_secret");
    expect(req.headers.accept).toBe("application/vnd.github+json");
  });
  it("encodes path segments but keeps slashes", () => {
    const req = buildContentsRequest(ok, "Claude/Replies/my note.md");
    expect(req.url).toContain("/contents/Claude/Replies/my%20note.md?ref=main");
  });
  it("throws on an invalid config", () => {
    expect(() => buildContentsRequest({ ...ok, token: "" }, "x")).toThrow(/token/i);
  });
});

describe("parseDirListing", () => {
  it("returns the files in a directory, skipping subdirs", () => {
    const body = JSON.stringify([
      { name: "a.md", path: "Claude/Replies/a.md", sha: "s1", type: "file" },
      { name: "sub", path: "Claude/Replies/sub", sha: "s2", type: "dir" },
      { name: "b.md", path: "Claude/Replies/b.md", sha: "s3", type: "file" },
    ]);
    expect(parseDirListing(200, body)).toEqual([
      { name: "a.md", path: "Claude/Replies/a.md", sha: "s1" },
      { name: "b.md", path: "Claude/Replies/b.md", sha: "s3" },
    ]);
  });
  it("handles a single-file (object) response", () => {
    const body = JSON.stringify({ name: "a.md", path: "Claude/Replies/a.md", sha: "s1", type: "file" });
    expect(parseDirListing(200, body)).toEqual([{ name: "a.md", path: "Claude/Replies/a.md", sha: "s1" }]);
  });
  it("explains a 404 (wrong repo/branch/folder)", () => {
    expect(() => parseDirListing(404, "{}")).toThrow(/not found/i);
  });
  it("explains a 401/403 as a token problem", () => {
    expect(() => parseDirListing(401, "{}")).toThrow(/token/i);
  });
});

describe("parseFileResponse", () => {
  it("decodes a base64 file body", () => {
    const body = JSON.stringify({ path: "Claude/Replies/a.md", sha: "s1", content: "SGVsbG8=", encoding: "base64" });
    expect(parseFileResponse(200, body)).toEqual({ path: "Claude/Replies/a.md", sha: "s1", text: "Hello" });
  });
  it("tolerates GitHub's newline-wrapped base64", () => {
    const body = JSON.stringify({ path: "a.md", sha: "s", content: "SGVsbG8=\n", encoding: "base64" });
    expect(parseFileResponse(200, body).text).toBe("Hello");
  });
  it("throws on a non-2xx status", () => {
    expect(() => parseFileResponse(404, "{}")).toThrow(/not found/i);
  });
});

describe("decodeBase64Utf8", () => {
  it("decodes multibyte UTF-8 correctly", () => {
    expect(decodeBase64Utf8("Y2Fmw6k=")).toBe("café");
  });
  it("returns empty for empty input", () => {
    expect(decodeBase64Utf8("")).toBe("");
  });
});

describe("isMarkdown", () => {
  it("matches .md case-insensitively", () => {
    expect(isMarkdown("a.md")).toBe(true);
    expect(isMarkdown("A.MD")).toBe(true);
    expect(isMarkdown("a.txt")).toBe(false);
  });
});
