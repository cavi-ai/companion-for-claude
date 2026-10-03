import { describe, expect, it } from "vitest";
import { normalizePublished, removePublished, renamePublished, upsertPublished, type PublishedItem } from "../../src/publish/registry";

const item = (over: Partial<PublishedItem> = {}): PublishedItem => ({
  key: "notes/a.md",
  kind: "note",
  title: "A",
  gistId: "g1",
  url: "https://gist.github.com/me/g1",
  owner: "me",
  publishedAt: 1,
  updatedAt: 1,
  ...over,
});

describe("published registry", () => {
  it("adds an item", () => {
    expect(upsertPublished([], item())).toEqual([item()]);
  });

  it("replaces an item with the same key in place", () => {
    const next = upsertPublished([item(), item({ key: "b.md", gistId: "g2" })], item({ gistId: "g9", updatedAt: 5 }));
    expect(next.map((i) => i.gistId)).toEqual(["g9", "g2"]);
  });

  it("removes by key and leaves others", () => {
    expect(removePublished([item(), item({ key: "b.md" })], "notes/a.md").map((i) => i.key)).toEqual(["b.md"]);
    expect(removePublished([item()], "missing")).toEqual([item()]);
  });

  it("re-keys a renamed note and nothing else", () => {
    const artifact = item({ key: "artifact:g2", kind: "artifact", gistId: "g2" });
    const next = renamePublished([item(), artifact], "notes/a.md", "moved/a.md");
    expect(next.map((i) => i.key)).toEqual(["moved/a.md", "artifact:g2"]);
    expect(renamePublished([item()], "other.md", "x.md")).toEqual([item()]);
  });

  it("keeps the existing entry when a rename lands on an occupied key", () => {
    const next = renamePublished([item(), item({ key: "b.md", gistId: "g2" })], "notes/a.md", "b.md");
    expect(next.map((i) => i.gistId)).toEqual(["g2"]);
  });

  it("normalizes persisted data and drops malformed entries", () => {
    const raw = [item(), { key: "x" }, null, 7, item({ kind: "other" as never }), item({ gistId: "" }), item({ key: "dup.md" }), item({ key: "dup.md", gistId: "g3" })];
    expect(normalizePublished(raw).map((i) => i.key)).toEqual(["notes/a.md", "dup.md"]);
  });

  it("normalizes a non-array to empty", () => {
    expect(normalizePublished(undefined)).toEqual([]);
    expect(normalizePublished({})).toEqual([]);
  });
});
