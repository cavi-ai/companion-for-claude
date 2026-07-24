import { describe, it, expect } from "vitest";
import { buildAtItems, filterAtItems, activeAtQuery, AT_SPECIALS } from "../src/context/atMention";

describe("buildAtItems", () => {
  it("leads with the four specials, then notes, then folders", () => {
    const items = buildAtItems(["Folder/Note.md"], ["Folder"]);
    expect(items.slice(0, 4).map((i) => i.kind)).toEqual(["note", "selection", "linked", "vault"]);
    const note = items.find((i) => i.kind === "note-path");
    expect(note).toMatchObject({ label: "Note", sublabel: "Folder/Note.md", path: "Folder/Note.md" });
    const folder = items.find((i) => i.kind === "folder-path");
    expect(folder).toMatchObject({ label: "Folder/", path: "Folder" });
  });
});

describe("filterAtItems", () => {
  const items = buildAtItems(["Research/Raft.md", "Cooking/Pasta.md"], ["Research"]);
  it("empty query returns specials + a slice", () => {
    const r = filterAtItems(items, "");
    expect(r.slice(0, 4)).toEqual(AT_SPECIALS.slice(0, 4));
  });
  it("matches on label and path, case-insensitive", () => {
    const r = filterAtItems(items, "raft");
    expect(r.some((i) => i.path === "Research/Raft.md")).toBe(true);
    expect(r.some((i) => i.path === "Cooking/Pasta.md")).toBe(false);
  });
  it("matches a special by its label", () => {
    const r = filterAtItems(items, "vault");
    expect(r.some((i) => i.kind === "vault")).toBe(true);
  });
});

describe("activeAtQuery", () => {
  it("detects @ at start", () => {
    expect(activeAtQuery("@raf", 4)).toEqual({ query: "raf", start: 0 });
  });
  it("detects @ after whitespace and allows spaces in the query", () => {
    const t = "summarize @My Note";
    expect(activeAtQuery(t, t.length)).toEqual({ query: "My Note", start: 10 });
  });
  it("ignores @ glued to a word (email-like)", () => {
    expect(activeAtQuery("mail me@x.com", 13)).toBeNull();
  });
  it("returns null when there's no @ before the cursor", () => {
    expect(activeAtQuery("no mention here", 15)).toBeNull();
  });
  it("stops at a newline", () => {
    const t = "@note\nmore";
    expect(activeAtQuery(t, t.length)).toBeNull();
  });
});

describe("media @-items", () => {
  it("lists media files after notes and folders, keeping extensions", () => {
    const items = buildAtItems(["A.md"], ["Docs"], ["Docs/paper.pdf", "img/shot.png"]);
    const media = items.filter((i) => i.kind === "media-path");
    expect(media.map((i) => i.label)).toEqual(["paper.pdf", "shot.png"]);
    expect(media[0]!.path).toBe("Docs/paper.pdf");
  });

  it("filters media by query like everything else", () => {
    const items = buildAtItems([], [], ["Docs/paper.pdf"]);
    expect(filterAtItems(items, "paper").map((i) => i.id)).toEqual(["media-path:Docs/paper.pdf"]);
  });
});
