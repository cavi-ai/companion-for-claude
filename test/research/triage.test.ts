import { describe, it, expect } from "vitest";
import { TRIAGE_SYSTEM, buildTriageUser, parseTriageResponse, renderTriageNote, themeTagSlug, noteExcerpt, type TriageNote } from "../../src/research/triage";

const notes: TriageNote[] = [
  { path: "Clippings/a.md", title: "Attention residue study", type: "article", url: "https://example.com/a", tags: ["clipping"], excerpt: "Participants took 23 minutes to refocus after an interruption." },
  { path: "Clippings/b.md", title: "Deep work in remote teams", type: "article", tags: [], excerpt: "Remote engineers report fragmented calendars." },
  { path: "Clippings/c.md", title: "Vitamin D meta-analysis", type: "article", tags: [], excerpt: "No significant effect on fracture risk in adults." },
];

describe("buildTriageUser", () => {
  it("lists notes with path, title, type, and excerpt, and demands JSON", () => {
    const user = buildTriageUser(notes);
    expect(user).toContain('"groups"');
    expect(user).toContain("Clippings/a.md");
    expect(user).toContain("Attention residue study");
    expect(user).toContain("https://example.com/a");
  });

  it("caps the number of notes sent", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...notes[0]!, path: `Clippings/n${i}.md` }));
    const user = buildTriageUser(many);
    expect(user).toContain("n59.md");
    expect(user).not.toContain("n60.md");
  });
});

describe("parseTriageResponse", () => {
  const valid = new Set(notes.map((n) => n.path));

  it("parses a clean response", () => {
    const raw = JSON.stringify({ groups: [
      { theme: "Attention & deep work", summary: "Interruption science.", researchIdea: "How does switching cost scale?", paths: ["Clippings/a.md", "Clippings/b.md"] },
      { theme: "Supplements", summary: "", researchIdea: "", paths: ["Clippings/c.md"] },
    ] });
    const groups = parseTriageResponse(raw, valid);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ theme: "Attention & deep work", paths: ["Clippings/a.md", "Clippings/b.md"] });
  });

  it("unwraps code fences and surrounding prose", () => {
    const raw = "Here you go:\n```json\n{\"groups\":[{\"theme\":\"T\",\"summary\":\"s\",\"researchIdea\":\"i\",\"paths\":[\"Clippings/a.md\"]}]}\n```";
    expect(parseTriageResponse(raw, valid)[0]?.paths).toEqual(["Clippings/a.md"]);
  });

  it("drops unknown paths, duplicate assignments, and empty groups", () => {
    const raw = JSON.stringify({ groups: [
      { theme: "One", paths: ["Clippings/a.md", "Clippings/missing.md"] },
      { theme: "Two", paths: ["Clippings/a.md"] },
      { theme: "Three", paths: ["Clippings/missing.md"] },
      { theme: "", paths: ["Clippings/b.md"] },
    ] });
    const groups = parseTriageResponse(raw, valid);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ theme: "One", paths: ["Clippings/a.md"] });
  });

  it("rejects non-JSON responses", () => {
    expect(() => parseTriageResponse("no json here", valid)).toThrow(/not JSON/);
    expect(() => parseTriageResponse("{ broken }", valid)).toThrow(/not valid JSON/);
    expect(() => parseTriageResponse("{\"other\":[]}", valid)).toThrow(/no groups/);
  });
});

describe("themeTagSlug", () => {
  it("nests a slugified theme under research/", () => {
    expect(themeTagSlug("Attention & Deep Work!")).toBe("research/attention-deep-work");
    expect(themeTagSlug("")).toBe("research/untriaged");
  });
});

describe("renderTriageNote", () => {
  it("renders a watcher-safe board with wikilinks, sources, and project ideas", () => {
    const groups = parseTriageResponse(JSON.stringify({ groups: [{ theme: "Attention", summary: "Sum.", researchIdea: "How?", paths: ["Clippings/a.md"] }] }), new Set(notes.map((n) => n.path)));
    const board = renderTriageNote(groups, new Map(notes.map((n) => [n.path, n])), "2026-07-24T12:00:00Z");
    expect(board).toContain("source_enriched: true");
    expect(board).toContain("## Attention");
    expect(board).toContain("**Potential project:** How?");
    expect(board).toContain("- [[Clippings/a.md|Attention residue study]] — [source](https://example.com/a)");
    expect(board).toContain("generated: 2026-07-24");
  });
});

describe("noteExcerpt", () => {
  it("strips frontmatter and collapses whitespace", () => {
    const content = "---\ntitle: X\n---\n\n# Heading\n\nSome **text** here.\n\nMore.";
    expect(noteExcerpt(content)).toBe("Heading Some text here. More.");
  });
});

describe("TRIAGE_SYSTEM", () => {
  it("demands JSON-only output and single membership", () => {
    expect(TRIAGE_SYSTEM).toContain("ONLY JSON");
    expect(TRIAGE_SYSTEM).toContain("at most one group");
  });
});
