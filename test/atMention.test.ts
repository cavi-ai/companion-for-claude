import { describe, it, expect } from "vitest";
import { buildAtItems, buildClaimItems, filterAtItems, activeAtQuery, activeHashQuery, AT_SPECIALS } from "../src/context/atMention";

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

describe("recent/base/claim @-items", () => {
  const claims = [{ path: "Research/Proj/Claims/C1.md", label: "Raft leader election avoids split votes", project: "Proj" }];

  it("orders as specials, recents, notes, folders, bases, claims, media", () => {
    const items = buildAtItems(["Folder/Note.md"], ["Folder"], ["img/shot.png"], ["DB/Tracker.base"], claims, ["Folder/Note.md"]);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(["note", "selection", "linked", "vault", "recent", "note-path", "folder-path", "base-path", "claim", "media-path"]);
  });

  it("labels a recent item 'Recent · <name>'", () => {
    const items = buildAtItems([], [], [], [], [], ["Folder/Note.md"]);
    const recent = items.find((i) => i.kind === "recent");
    expect(recent).toMatchObject({ label: "Recent · Note", sublabel: "Folder/Note.md", path: "Folder/Note.md" });
  });

  it("labels a base item '<name>.base'", () => {
    const items = buildAtItems([], [], [], ["DB/Tracker.base"]);
    const base = items.find((i) => i.kind === "base-path");
    expect(base).toMatchObject({ label: "Tracker.base", sublabel: "DB/Tracker.base", path: "DB/Tracker.base" });
  });

  it("labels a claim with its proposition and sublabels it with the project", () => {
    const items = buildClaimItems(claims);
    expect(items).toEqual([{ id: "claim:Research/Proj/Claims/C1.md", kind: "claim", label: "Raft leader election avoids split votes", sublabel: "Proj", path: "Research/Proj/Claims/C1.md" }]);
  });

  it("trims a long claim proposition to 80 chars", () => {
    const long = "x".repeat(120);
    const items = buildClaimItems([{ path: "C.md", label: long, project: "Proj" }]);
    expect(items[0]!.label).toBe(`${"x".repeat(80)}…`);
  });

  it("filter matches claim text and project", () => {
    const items = buildClaimItems(claims);
    expect(filterAtItems(items, "split votes").map((i) => i.id)).toEqual(["claim:Research/Proj/Claims/C1.md"]);
    expect(filterAtItems(items, "proj").map((i) => i.id)).toEqual(["claim:Research/Proj/Claims/C1.md"]);
    expect(filterAtItems(items, "nope")).toEqual([]);
  });

  it("empty query returns specials + recents first", () => {
    const items = buildAtItems(["A.md"], [], [], [], [], ["A.md"]);
    const r = filterAtItems(items, "");
    expect(r.slice(0, 4)).toEqual(AT_SPECIALS.slice(0, 4));
    expect(r[4]).toMatchObject({ kind: "recent" });
  });
});

describe("project @-items", () => {
  const projects = [{ id: "Claude/Projects/Launch.md", name: "Launch" }];

  it("badges a project item and places it right after the specials", () => {
    const items = buildAtItems([], [], [], [], [], [], projects);
    expect(items.slice(0, 5).map((i) => i.kind)).toEqual(["note", "selection", "linked", "vault", "project"]);
    const project = items.find((i) => i.kind === "project");
    expect(project).toMatchObject({ id: "project:Claude/Projects/Launch.md", label: "Launch", sublabel: "project", path: "Claude/Projects/Launch.md" });
  });

  it("filters project items like everything else", () => {
    const items = buildAtItems([], [], [], [], [], [], projects);
    expect(filterAtItems(items, "launch").some((i) => i.kind === "project")).toBe(true);
    expect(filterAtItems(items, "nope").some((i) => i.kind === "project")).toBe(false);
  });
});

describe("activeHashQuery", () => {
  it("detects # at start", () => {
    expect(activeHashQuery("#raf", 4)).toEqual({ query: "raf", start: 0 });
  });
  it("detects # after whitespace and allows spaces in the query", () => {
    const t = "check #split vote";
    expect(activeHashQuery(t, t.length)).toEqual({ query: "split vote", start: 6 });
  });
  it("ignores # glued to a word", () => {
    expect(activeHashQuery("issue#42", 8)).toBeNull();
  });
  it("returns null when there's no # before the cursor", () => {
    expect(activeHashQuery("no hash here", 12)).toBeNull();
  });
  it("stops at a newline", () => {
    const t = "#claim\nmore";
    expect(activeHashQuery(t, t.length)).toBeNull();
  });
});
