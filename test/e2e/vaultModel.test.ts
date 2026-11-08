import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { markdownTextHash, vaultModelIssues } from "../../e2e/rig/vaultModel";

const expected = { directories: ["Notes"], files: { "Notes/Alpha.md": "march-content-sha256" } };

describe("native fixture vault synchronization", () => {
  it("keeps deletion pending while a recorded folder or file remains in the native model", () => {
    expect(vaultModelIssues("removed", expected, { paths: ["Notes", "Notes/Alpha.md"], hashes: {}, markdownPaths: ["Notes/Alpha.md"], cachedHashes: {} }, expected.files)).toEqual([
      { path: "Notes", problem: "still-present" },
      { path: "Notes/Alpha.md", problem: "still-present" },
    ]);
    expect(vaultModelIssues("removed", expected, { paths: ["Notes"], hashes: {}, markdownPaths: [], cachedHashes: {} }, expected.files)).toEqual([{ path: "Notes", problem: "still-present" }]);
  });

  it("acknowledges deletion only after the recorded paths are absent", () => {
    expect(vaultModelIssues("removed", expected, { paths: [""], hashes: {}, markdownPaths: [], cachedHashes: {} }, expected.files)).toEqual([]);
  });

  it("refuses to use seeded files that exist on disk but are missing from the native model", () => {
    expect(vaultModelIssues("seeded", expected, { paths: ["Notes"], hashes: {}, markdownPaths: [], cachedHashes: {} }, expected.files)).toEqual([{ path: "Notes/Alpha.md", problem: "missing" }]);
  });

  it("requires the recorded folder as well as its file", () => {
    expect(vaultModelIssues("seeded", expected, { paths: ["Notes/Alpha.md"], hashes: { "Notes/Alpha.md": "march-content-sha256" }, markdownPaths: ["Notes/Alpha.md"], cachedHashes: { "Notes/Alpha.md": "march-content-sha256" } }, expected.files)).toEqual([{ path: "Notes", problem: "missing" }]);
  });

  it("rejects stale or unreadable native contents even when the path is loaded", () => {
    for (const hashes of [{ "Notes/Alpha.md": "november-content-sha256" }, {}]) {
      expect(vaultModelIssues("seeded", expected, { paths: ["Notes", "Notes/Alpha.md"], hashes, markdownPaths: ["Notes/Alpha.md"], cachedHashes: { "Notes/Alpha.md": "march-content-sha256" } }, expected.files)).toEqual([{ path: "Notes/Alpha.md", problem: "content-mismatch" }]);
    }
  });

  it("allows use after every recorded path and native content hash matches", () => {
    expect(vaultModelIssues("seeded", expected, { paths: ["", "Notes", "Notes/Alpha.md"], hashes: { "Notes/Alpha.md": "march-content-sha256" }, markdownPaths: ["Notes/Alpha.md"], cachedHashes: { "Notes/Alpha.md": "march-content-sha256" } }, expected.files)).toEqual([]);
  });
});

describe("native UTF-8 text expectations", () => {
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const path = "Metadata source.md";
  const input = "\uFEFF---\r\ntitle: Evidence\r\n---\r\n\r\nBody\uFEFFtext\r\n";
  const rawHash = digest(input);
  const textHash = digest(input.slice(1));
  const snapshot = { directories: [], files: { [path]: rawHash } };
  const model = { paths: [path], hashes: { [path]: rawHash }, markdownPaths: [path], cachedHashes: { [path]: textHash } };

  it("accepts exact raw bytes and the independently decoded native text digest", () => {
    expect(vaultModelIssues("seeded", snapshot, model, { [path]: textHash })).toEqual([]);
  });
  it("decodes only the leading UTF-8 BOM, preserving CRLF and an interior BOM", () => {
    expect(markdownTextHash(Buffer.from(input))).toBe(textHash);
    expect(markdownTextHash(Buffer.from(input))).not.toBe(digest(input.slice(1).replace(/\r\n/g, "\n")));
    expect(markdownTextHash(Buffer.from(input))).not.toBe(digest(input.replace(/\uFEFF/g, "")));
  });
  it("still rejects stale cached text, changed raw bytes and missing text expectations", () => {
    expect(vaultModelIssues("seeded", snapshot, { ...model, cachedHashes: { [path]: digest("Older revision") } }, { [path]: textHash })).toEqual([{ path, problem: "cached-content-mismatch" }]);
    expect(vaultModelIssues("seeded", snapshot, { ...model, hashes: { [path]: textHash } }, { [path]: textHash })).toEqual([{ path, problem: "content-mismatch" }]);
    expect(vaultModelIssues("seeded", snapshot, model, {})).toEqual([{ path, problem: "cached-content-mismatch" }]);
  });
});

describe("Markdown consumer readiness", () => {
  it("rejects matching raw bytes while the Markdown consumer list omits the file", () => {
    const observed = { paths: ["Notes", "Notes/Alpha.md"], hashes: { "Notes/Alpha.md": "march-content-sha256" }, markdownPaths: [], cachedHashes: {} };
    expect(vaultModelIssues("seeded", expected, observed, expected.files)).toEqual([{ path: "Notes/Alpha.md", problem: "missing-markdown" }]);
  });

  it("rejects stale or unreadable cachedRead content despite matching raw bytes", () => {
    for (const cachedHashes of [{ "Notes/Alpha.md": "november-content-sha256" }, {}]) {
      const observed = { paths: ["Notes", "Notes/Alpha.md"], hashes: { "Notes/Alpha.md": "march-content-sha256" }, markdownPaths: ["Notes/Alpha.md"], cachedHashes };
      expect(vaultModelIssues("seeded", expected, observed, expected.files)).toEqual([{ path: "Notes/Alpha.md", problem: "cached-content-mismatch" }]);
    }
  });

  it("keeps deletion pending when the Markdown list still exposes an old file", () => {
    const observed = { paths: [], hashes: {}, markdownPaths: ["Notes/Alpha.md"], cachedHashes: {} };
    expect(vaultModelIssues("removed", expected, observed, expected.files)).toEqual([{ path: "Notes/Alpha.md", problem: "still-present" }]);
  });
});
