import { describe, expect, it } from "vitest";
import { buildContextManagerModel } from "../../src/view/contextManagerModel";

const off = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

describe("buildContextManagerModel", () => {
  it("summarizes empty, concise, dense, and long-primary context", () => {
    expect(buildContextManagerModel({ toggles: off, activeNotePath: null, paths: [], media: [], pages: [] }).summary).toBe("Add context");
    expect(buildContextManagerModel({ toggles: { ...off, activeNote: true }, activeNotePath: "Notes/Alpha.md", paths: [], media: [], pages: [] }).summary).toBe("Context · This note");
    expect(buildContextManagerModel({ toggles: { ...off, activeNote: true, linkedNotes: true }, activeNotePath: "Notes/Alpha.md", paths: [{ kind: "folder", path: "Research" }], media: [], pages: [] }).summary).toBe("Context · This note + 2");
    expect(buildContextManagerModel({ toggles: off, activeNotePath: null, paths: [{ kind: "note", path: "Notes/A source name that is deliberately too long for the trigger.md" }], media: [], pages: [] }).summary).toBe("Context · 1");
  });

  it("counts and classifies every automatic and explicit source", () => {
    const input = {
      toggles: { activeNote: true, selection: true, linkedNotes: true, searchVault: true },
      activeNotePath: "Notes/Alpha.md",
      paths: [
        { kind: "note" as const, path: "Research/Alpha/Project.md" },
        { kind: "note" as const, path: "Notes/Long note.md" },
        { kind: "folder" as const, path: "Research/Sources" },
      ],
      media: [
        { kind: "pdf" as const, label: "Study.pdf", mime: "application/pdf", path: "Files/Study.pdf" },
        { kind: "image" as const, label: "Figure.png", mime: "image/png", path: "Files/Figure.png" },
      ],
      pages: [
        { url: "https://pending.test/article", markdown: "", pending: true },
        { url: "https://failed.test/article", markdown: "", error: "Capture timed out" },
      ],
    };
    const before = structuredClone(input);

    const model = buildContextManagerModel(input);

    expect(model.activeCount).toBe(11);
    expect(model.sources.map(({ kind, status }) => [kind, status])).toEqual([
      ["project", "ready"],
      ["note", "ready"],
      ["folder", "ready"],
      ["pdf", "ready"],
      ["image", "ready"],
      ["webpage", "pending"],
      ["webpage", "error"],
    ]);
    expect(model.sources.at(-1)).toMatchObject({
      id: "page:https://failed.test/article",
      label: "failed.test/article",
      error: "Capture timed out",
    });
    expect(model.sources.at(-1)?.detail).toBeUndefined();
    expect(input).toEqual(before);
  });

  it("uses deterministic IDs and changes its signature for every visible change", () => {
    const base = { toggles: off, activeNotePath: null, paths: [], media: [], pages: [] };
    expect(buildContextManagerModel(base).signature).toBe(buildContextManagerModel(structuredClone(base)).signature);
    expect(buildContextManagerModel(base).signature).not.toBe(buildContextManagerModel({ ...base, activeNotePath: "A.md" }).signature);

    const media = buildContextManagerModel({
      ...base,
      media: [
        { kind: "image", label: "Pasted image 1", mime: "image/png", data: "abc" },
        { kind: "image", label: "Pasted image 2", mime: "image/png", data: "def" },
      ],
    });
    expect(media.sources.map(({ id }) => id)).toEqual(["media:image:inline:0", "media:image:inline:1"]);
  });

  it("does not repeat an untitled webpage URL but retains the domain under a titled page", () => {
    const model = buildContextManagerModel({
      toggles: off,
      activeNotePath: null,
      paths: [],
      media: [],
      pages: [
        { url: "https://example.test/plain", markdown: "body" },
        { url: "https://example.test/titled", title: "Readable article", markdown: "body" },
      ],
    });

    expect(model.sources[0]).toMatchObject({ label: "example.test/plain" });
    expect(model.sources[0]?.detail).toBeUndefined();
    expect(model.sources[1]).toMatchObject({ label: "Readable article", detail: "example.test/titled" });
  });
});
