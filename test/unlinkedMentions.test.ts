import { describe, it, expect } from "vitest";
import { findUnlinkedMentions, linkMention, withLinktext, type LinkCandidate } from "../src/links/unlinkedMentions";

const candidates: LinkCandidate[] = [
  { path: "Projects/Companion Agent Mode.md", basename: "Companion Agent Mode", aliases: ["agent mode"] },
  { path: "Weekly Review.md", basename: "Weekly Review", aliases: [] },
  { path: "GTD.md", basename: "GTD", aliases: [] },
  { path: "Ok.md", basename: "Ok", aliases: [] }, // <3 chars — never suggested
];

const reactCandidates: LinkCandidate[] = [{ path: "react.md", basename: "react", aliases: [] }];

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

  it("skips code fences inside list items and callouts", () => {
    const content = "- deploy step:\n  ```bash\n  run # Weekly Review\n  ```\n> [!note]\n> ```\n> Weekly Review\n> ```\nBut GTD in prose.";
    expect(findUnlinkedMentions(content, candidates, "X.md").map((m) => m.path)).toEqual(["GTD.md"]);
  });

  it("keeps a fence open across list-marked or quoted fence lines inside it", () => {
    for (const inner of ["- ```", "> ```", "1. ```"]) {
      expect(findUnlinkedMentions(`\`\`\`\n${inner}\nGTD\n\`\`\`\n`, candidates, "X.md")).toEqual([]);
    }
  });

  it("finds and links mentions after a character whose lowercase is longer (İ)", () => {
    const content = "Trip to İstanbul, then a Weekly Review.";
    const [m] = findUnlinkedMentions(content, candidates, "X.md");
    expect(m).toMatchObject({ path: "Weekly Review.md", surface: "Weekly Review" });
    expect(linkMention(content, m!)).toBe("Trip to İstanbul, then a [[Weekly Review]].");
  });

  it("finds mentions after an unclosed indented ```", () => {
    expect(findUnlinkedMentions("    ```\nGTD\n", candidates, "X.md").map((m) => m.path)).toEqual(["GTD.md"]);
  });

  it("finds a mention between an empty frontmatter block and a later horizontal rule", () => {
    const content = "---\n---\nThe Weekly Review.\n\n---\n\nAfter.";
    expect(findUnlinkedMentions(content, candidates, "X.md").map((m) => m.path)).toEqual(["Weekly Review.md"]);
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

  it("does not match inside a bare URL", () => {
    const content = "See https://github.com/remix-run/react-router for routing.";
    expect(findUnlinkedMentions(content, reactCandidates, "X.md")).toEqual([]);
  });

  it("does not match inside an autolink", () => {
    const content = "See <https://example.com/react> for details.";
    expect(findUnlinkedMentions(content, reactCandidates, "X.md")).toEqual([]);
  });

  it("still finds the mention in plain prose", () => {
    const content = "react is a UI library";
    const paths = findUnlinkedMentions(content, reactCandidates, "X.md").map((m) => m.path);
    expect(paths).toEqual(["react.md"]);
  });

  it("does not match inside a tag", () => {
    expect(findUnlinkedMentions("Tagged #react today", reactCandidates, "X.md")).toEqual([]);
    expect(findUnlinkedMentions("#ai/react", reactCandidates, "X.md")).toEqual([]);
  });

  it("still finds a mention after a heading hash", () => {
    const content = "# React\n\nSome intro.";
    const paths = findUnlinkedMentions(content, reactCandidates, "X.md").map((m) => m.path);
    expect(paths).toEqual(["react.md"]);
  });

  it("normalizes a note once regardless of candidate count", () => {
    const content = "A long mobile note about Weekly Review. ".repeat(2_000);
    const many: LinkCandidate[] = Array.from({ length: 500 }, (_, i) => ({
      path: `Topic ${i}.md`,
      basename: `Topic ${i}`,
      aliases: [],
    }));
    let noteNormalizations = 0;
    const originalToLowerCase = String.prototype.toLowerCase;

    String.prototype.toLowerCase = function (this: string): string {
      if (this.length === content.length) noteNormalizations += 1;
      return originalToLowerCase.call(this);
    };

    try {
      findUnlinkedMentions(content, many, "X.md");
    } finally {
      String.prototype.toLowerCase = originalToLowerCase;
    }

    expect(noteNormalizations).toBe(1);
  });
});

/** The original per-candidate scan, kept as the oracle for the single-pass index. Prose-only input, so no masking. */
function naiveMentions(content: string, cands: LinkCandidate[], selfPath: string) {
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  const lower = content.toLowerCase();
  const found: Array<{ path: string; start: number; end: number; viaAlias: boolean; surface: string }> = [];
  for (const c of cands) {
    if (c.path === selfPath) continue;
    let best: (typeof found)[number] | null = null;
    for (const { name, viaAlias } of [{ name: c.basename, viaAlias: false }, ...c.aliases.map((name) => ({ name, viaAlias: true }))]) {
      if (name.trim().length < 3) continue;
      const needle = name.toLowerCase();
      let idx = lower.indexOf(needle);
      while (idx !== -1 && (isWordChar(content[idx - 1]) || isWordChar(content[idx + needle.length]))) idx = lower.indexOf(needle, idx + 1);
      if (idx !== -1 && (best === null || idx < best.start)) best = { path: c.path, start: idx, end: idx + name.length, viaAlias, surface: content.slice(idx, idx + name.length) };
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => a.start - b.start).slice(0, 20);
}

describe("findUnlinkedMentions matches the per-candidate scan", () => {
  it("on 300 random prose notes against overlapping names and aliases", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const words = ["alpha", "Alpha", "alphabet", "beta", "gamma", "delta", "al", "pha", "Beta Gamma", "gam", "x_alpha", "élan", "Élan", "42"];
    const seps = [" ", " ", " ", ", ", ".\n", "\n\n", "-", "_"];
    for (let round = 0; round < 300; round++) {
      const cands: LinkCandidate[] = Array.from({ length: 1 + Math.floor(rand() * 30) }, (_, i) => ({
        path: `N${i}.md`,
        basename: Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick(words)).join(" "),
        aliases: Array.from({ length: Math.floor(rand() * 3) }, () => Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick(words)).join(pick([" ", "-"]))),
      }));
      const content = Array.from({ length: 5 + Math.floor(rand() * 60) }, () => pick(words) + pick(seps)).join("");
      const self = pick(cands).path;
      const actual = findUnlinkedMentions(content, cands, self).map(({ path, start, end, viaAlias, surface }) => ({ path, start, end, viaAlias, surface }));
      expect(actual).toEqual(naiveMentions(content, cands, self));
    }
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

  it("links a duplicate basename by its full path", () => {
    const dupCandidates = withLinktext([
      { path: "Research/A/Project.md", basename: "Project", aliases: [] },
      { path: "Research/B/Project.md", basename: "Project", aliases: [] },
    ]);
    const content = "The Project plan needs review.";
    const [m] = findUnlinkedMentions(content, dupCandidates, "Other.md");
    const linked = linkMention(content, m!);
    expect(linked).toContain("|Project]]");
    expect(linked).toMatch(/\[\[Research\/[AB]\/Project\|Project]]/);
  });
});

describe("withLinktext", () => {
  it("leaves a unique basename as-is", () => {
    const [c] = withLinktext([{ path: "Notes/Name.md", basename: "Name", aliases: [] }]);
    expect(c!.linktext).toBe("Name");
  });

  it("uses the full path (sans .md) for duplicate basenames, case-insensitively", () => {
    const out = withLinktext([
      { path: "Research/A/Project.md", basename: "Project", aliases: [] },
      { path: "Research/B/project.md", basename: "project", aliases: [] },
    ]);
    expect(out.map((c) => c.linktext)).toEqual(["Research/A/Project", "Research/B/project"]);
  });
});
