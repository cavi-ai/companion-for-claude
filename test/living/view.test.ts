import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/living/fingerprint";
import { buildViewNote, defaultViewPath, livingKindFor, noteBody, readBinding } from "../../src/living/view";

describe("livingKindFor", () => {
  it("maps articles to argument maps, videos to chapter maps and CSV datasets to explorers, and nothing else", () => {
    expect(livingKindFor({ type: "article" })).toBe("argument-map");
    expect(livingKindFor({ type: "video" })).toBe("chapter-map");
    expect(livingKindFor({ type: "dataset", asset: "Data/prices.CSV" })).toBe("dataset-explorer");
    expect(livingKindFor({ type: "dataset", asset: "Data/prices.xlsx" })).toBeNull();
    expect(livingKindFor({ type: "dataset" })).toBeNull();
    expect(livingKindFor({ type: "person" })).toBeNull();
    expect(livingKindFor({ type: "living-view" })).toBeNull();
    expect(livingKindFor(undefined)).toBeNull();
  });
});

describe("view notes", () => {
  it("place each kind under Living views with a file-safe name", () => {
    expect(defaultViewPath("Claude/Artifacts/", "Tide: Study?", "argument-map")).toBe("Claude/Artifacts/Living views/Tide Study — argument map.md");
    expect(defaultViewPath("", "Prices", "dataset-explorer")).toBe("Living views/Prices — dataset explorer.md");
  });

  it("round-trip their binding through the frontmatter they are written with", () => {
    const note = buildViewNote({
      title: "Tide Study — argument map",
      source: "Sources/Tide Study",
      kind: "argument-map",
      hash: "0badf00d-42",
      generated: "2026-10-19T14:00:00.000Z",
      html: "<p>map</p>",
    });
    expect(readBinding(note)).toEqual({ source: "Sources/Tide Study", kind: "argument-map", hash: "0badf00d-42", generated: "2026-10-19T14:00:00.000Z" });
    expect(note).toContain("```claude-living\n```");
    expect(note).toContain("```claude-html height=720\n<p>map</p>\n```");
    expect(noteBody(note).startsWith("```claude-living")).toBe(true);
    expect(note).toContain('title: "Tide Study — argument map"');
    expect(buildViewNote({ ...readBinding(note)!, title: "T", html: "<p/>", after: "## Watch\n\n- [0:00 Start](https://youtu.be/x)" }).endsWith("```\n\n## Watch\n\n- [0:00 Start](https://youtu.be/x)\n")).toBe(true);
  });

  it("read no binding from a note without a source link, kind, or fingerprint", () => {
    expect(readBinding("# Plain note")).toBeNull();
    expect(readBinding("---\nliving_source: Sources/Tide\nliving_kind: argument-map\nliving_hash: x\n---")).toBeNull();
    expect(readBinding('---\nliving_source: "[[Tide]]"\nliving_kind: video-map\nliving_hash: x\n---')).toBeNull();
    expect(readBinding('---\nliving_source: "[[Tide|alias]]"\nliving_kind: argument-map\nliving_hash: x\n---')?.source).toBe("Tide");
  });
});

describe("fingerprint", () => {
  it("is stable for the same text and changes with any edit", () => {
    expect(fingerprint("tides")).toBe(fingerprint("tides"));
    expect(fingerprint("tides")).not.toBe(fingerprint("tides."));
    expect(fingerprint("")).toMatch(/^[0-9a-f]{8}-0$/);
  });
});
