import { describe, it, expect } from "vitest";
import { findUnlinkedMentions, linkMention, type LinkCandidate } from "../src/links/unlinkedMentions";

const candidates: LinkCandidate[] = [
  { path: "Projects/Companion Agent Mode.md", basename: "Companion Agent Mode", aliases: ["agent mode"] },
  { path: "Weekly Review.md", basename: "Weekly Review", aliases: [] },
  { path: "GTD.md", basename: "GTD", aliases: [] },
  { path: "Ok.md", basename: "Ok", aliases: [] }, // <3 chars — never suggested
];

describe("findUnlinkedMentions", () => {
  it("finds a whole-word title mention with position and line", () => {
    const content = "Plans\n\nThe Weekly Review went well.\n";
    const [m] = findUnlinkedMentions(content, candidates, "Notes/Today.md");
    expect(m).toMatchObject({ path: "Weekly Review.md", surface: "Weekly Review", line: 3 });
    expect(content.slice(m!.start, m!.end)).toBe("Weekly Review");
  });

  it("matches case-insensitively and via aliases", () => {
    const content = "we shipped agent mode and did a weekly review today";
    const paths = findUnlinkedMentions(content, candidates, "X.md").map((m) => m.path);
    expect(paths).toContain("Projects/Companion Agent Mode.md");
    expect(paths).toContain("Weekly Review.md");
  });

  it("requires word boundaries", () => {
    const content = "MyGTDish setup, GTDs, and nothing else";
    expect(findUnlinkedMentions(content, candidates, "X.md")).toEqual([]);
  });

  it("skips mentions already inside wikilinks and markdown links", () => {
    const content = "See [[Weekly Review]] and [Weekly Review](Weekly%20Review.md) here.";
    expect(findUnlinkedMentions(content, candidates, "X.md")).toEqual([]);
  });

  it("skips piped wikilink aliases", () => {
    const content = "See [[Weekly Review|the review]] for details on GTD.";
    const paths = findUnlinkedMentions(content, candidates, "X.md").map((m) => m.path);
    expect(paths).toEqual(["GTD.md"]);
  });

  it("skips frontmatter, code fences, and inline code", () => {
    const content = `---
title: Weekly Review
---
\`\`\`
Weekly Review inside a fence
\`\`\`
And \`Weekly Review\` inline. But GTD in prose.`;
    const paths = findUnlinkedMentions(content, candidates, "X.md").map((m) => m.path);
    expect(paths).toEqual(["GTD.md"]);
  });

  it("never suggests the note itself or short names", () => {
    const content = "Weekly Review and Ok are words.";
    const paths = findUnlinkedMentions(content, candidates, "Weekly Review.md").map((m) => m.path);
    expect(paths).toEqual([]);
  });

  it("reports only the first occurrence per target and caps total results", () => {
    const content = "GTD GTD GTD. Weekly Review twice: Weekly Review.";
    const ms = findUnlinkedMentions(content, candidates, "X.md");
    expect(ms.filter((m) => m.path === "GTD.md")).toHaveLength(1);
    expect(ms.filter((m) => m.path === "Weekly Review.md")).toHaveLength(1);
    const many: LinkCandidate[] = Array.from({ length: 40 }, (_, i) => ({ path: `N${i}.md`, basename: `Topic${i}xyz`, aliases: [] }));
    const bigContent = many.map((c) => c.basename).join(" ");
    expect(findUnlinkedMentions(bigContent, many, "X.md").length).toBeLessThanOrEqual(20);
  });
});

describe("linkMention", () => {
  it("wraps an exact-case basename match as a plain wikilink", () => {
    const content = "The Weekly Review went well.";
    const [m] = findUnlinkedMentions(content, candidates, "X.md");
    expect(linkMention(content, m!)).toBe("The [[Weekly Review]] went well.");
  });

  it("uses the pipe form when the surface text differs from the basename", () => {
    const content = "the weekly review went well";
    const [m] = findUnlinkedMentions(content, candidates, "X.md");
    expect(linkMention(content, m!)).toBe("the [[Weekly Review|weekly review]] went well");
  });

  it("uses the pipe form for alias matches", () => {
    const content = "we shipped agent mode today";
    const [m] = findUnlinkedMentions(content, candidates, "X.md");
    expect(linkMention(content, m!)).toBe("we shipped [[Companion Agent Mode|agent mode]] today");
  });

  it("throws if the content drifted", () => {
    const content = "The Weekly Review went well.";
    const [m] = findUnlinkedMentions(content, candidates, "X.md");
    expect(() => linkMention("something else entirely", m!)).toThrow(/changed/i);
  });
});
