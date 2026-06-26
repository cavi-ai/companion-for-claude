import { describe, it, expect } from "vitest";
import { shouldEnrich } from "../../src/sources/watcher";

const base = { inboxFolder: "Clippings", recentlyWritten: new Set<string>() };

describe("shouldEnrich", () => {
  it("enriches a fresh markdown clip in the inbox", () => {
    expect(shouldEnrich({ ...base, path: "Clippings/a.md", ext: "md", content: "---\nsource: x\n---" })).toBe(true);
  });
  it("enriches a CSV in the inbox", () => {
    expect(shouldEnrich({ ...base, path: "Clippings/a.csv", ext: "csv", content: "a,b" })).toBe(true);
  });
  it("skips a note already enriched", () => {
    expect(shouldEnrich({ ...base, path: "Clippings/a.md", ext: "md", content: "---\nsource_enriched: true\n---" })).toBe(false);
  });
  it("skips files outside the inbox", () => {
    expect(shouldEnrich({ ...base, path: "Notes/a.md", ext: "md", content: "" })).toBe(false);
  });
  it("skips unsupported extensions", () => {
    expect(shouldEnrich({ ...base, path: "Clippings/a.png", ext: "png", content: "" })).toBe(false);
  });
  it("skips files we just wrote", () => {
    expect(shouldEnrich({ ...base, recentlyWritten: new Set(["Clippings/a.md"]), path: "Clippings/a.md", ext: "md", content: "" })).toBe(false);
  });
});
