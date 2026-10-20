import { describe, expect, it } from "vitest";
import { checkCitations, currentCitationTargets, extractCitations, resolveCitationPath, sectionExcerpt } from "../../src/chat/provenance";

describe("resolveCitationPath", () => {
  const paths = ["Projects/A/Overview.md", "Projects/B/Overview.md", "Notes/Unique.md", "Overview.md"];
  it("refuses a shared short name instead of picking one project", () => {
    expect(resolveCitationPath("Overview", paths)).toEqual({ path: null, ambiguous: true });
  });
  it("resolves qualified and root paths exactly and retains unique legacy names", () => {
    expect(resolveCitationPath("Projects/B/Overview.md", paths).path).toBe("Projects/B/Overview.md");
    expect(resolveCitationPath("Projects/B/Overview", paths).path).toBe("Projects/B/Overview.md");
    expect(resolveCitationPath("Overview.md", paths).path).toBe("Overview.md");
    expect(resolveCitationPath("Unique", paths).path).toBe("Notes/Unique.md");
  });
  it("does not substitute another folder when an explicit path is missing", () => {
    expect(resolveCitationPath("Projects/C/Overview.md", paths)).toEqual({ path: null, ambiguous: false });
  });
});

it("copies saved citation targets and rejects malformed persisted targets", () => {
  const targets = [{ linkpath: "Alpha", heading: "Findings", path: "Notes/Alpha.md" }];
  const copy = currentCitationTargets(targets)!;
  copy[0]!.path = "Archive/Alpha.md";
  expect(targets[0]!.path).toBe("Notes/Alpha.md");
  for (const raw of [null, {}, [null], [{ linkpath: "Alpha", heading: 1, path: "Notes/Alpha.md" }], [{ linkpath: "Alpha", heading: null, path: false }]]) expect(currentCitationTargets(raw)).toBeUndefined();
});

describe("extractCitations", () => {
  it("returns each cited note and section once, in first-seen order", () => {
    const reply = "Started in March [[Alpha#Findings]], see [[Alpha]] and [[Beta|the beta note]]. Again [[alpha#findings]] and [[Gamma#^block1]].";
    expect(extractCitations(reply)).toEqual([
      { linkpath: "Alpha", heading: "Findings" },
      { linkpath: "Alpha", heading: null },
      { linkpath: "Beta", heading: null },
      { linkpath: "Gamma", heading: null },
    ]);
  });

  it("skips embeds, same-note anchors, and links inside code", () => {
    const reply = [
      "![[Diagram.png]] and [[#Local heading]] and `[[Inline]]`.",
      "```claude-html",
      "<p>[[Fenced]]</p>",
      "```",
      "~~~",
      "[[Tilde]]",
      "~~~",
      "Real [[Kept]].",
    ].join("\n");
    expect(extractCitations(reply)).toEqual([{ linkpath: "Kept", heading: null }]);
  });
});

describe("sectionExcerpt", () => {
  const note = [
    "---",
    "title: Alpha",
    "---",
    "# Alpha",
    "",
    "## Findings ##",
    "",
    "The migration started in March",
    "and finished in May.",
    "```",
    "## Not a heading",
    "```",
    "## Open: questions",
    "Who owns the rollback?",
  ].join("\n");

  it("returns the section's opening text, matching headings like Obsidian links do", () => {
    expect(sectionExcerpt(note, "findings")).toBe("The migration started in March and finished in May.");
    expect(sectionExcerpt(note, "Open questions")).toBe("Who owns the rollback?");
    expect(sectionExcerpt(note, "Alpha#Open questions")).toBe("Who owns the rollback?");
  });

  it("returns null for a heading the note lacks, including one inside a code fence", () => {
    expect(sectionExcerpt(note, "Not a heading")).toBeNull();
    expect(sectionExcerpt(note, "title: Alpha")).toBeNull();
  });

  it("clips long sections", () => {
    const excerpt = sectionExcerpt(`## Long\n${"word ".repeat(100)}`, "Long")!;
    expect(excerpt.length).toBeLessThanOrEqual(160);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("checkCitations", () => {
  it("reports an ambiguous name without treating an arbitrary matching note as its source", async () => {
    const checked = await checkCitations([{ linkpath: "Overview", heading: "Findings" }], {
      resolve: () => null,
      ambiguous: () => true,
      read: async () => { throw new Error("No source was identified"); },
    });
    expect(checked[0]).toMatchObject({ status: "ambiguous", path: null, excerpt: null });
  });
  it("marks each citation found, section missing, or not in the vault", async () => {
    const notes: Record<string, string> = { "Notes/Alpha.md": "## Findings\nStarted in March.", "Files/chart.png": "" };
    const vault = {
      resolve: (linkpath: string) => Object.keys(notes).find((path) => path.split("/").pop()!.replace(/\.md$/, "") === linkpath) ?? null,
      read: async (path: string) => notes[path]!,
    };
    const checked = await checkCitations([
      { linkpath: "Alpha", heading: "Findings" },
      { linkpath: "Alpha", heading: "Methods" },
      { linkpath: "Alpha", heading: null },
      { linkpath: "Ghost", heading: null },
      { linkpath: "chart.png", heading: "Axis" },
    ], vault);
    expect(checked.map((c) => [c.status, c.path, c.excerpt])).toEqual([
      ["found", "Notes/Alpha.md", "Started in March."],
      ["no-section", "Notes/Alpha.md", null],
      ["found", "Notes/Alpha.md", null],
      ["missing", null, null],
      ["no-section", "Files/chart.png", null],
    ]);
  });
});
