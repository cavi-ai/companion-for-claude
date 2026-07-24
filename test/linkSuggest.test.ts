import { describe, it, expect } from "vitest";
import { buildSuggestions, mentionEdits } from "../src/links/suggest";
import { findUnlinkedMentions, type LinkCandidate } from "../src/links/unlinkedMentions";
import { planEdits, applyPlan } from "../src/edit/diff";

const candidates: LinkCandidate[] = [
  { path: "Weekly Review.md", basename: "Weekly Review", aliases: [] },
  { path: "GTD.md", basename: "GTD", aliases: [] },
];

describe("buildSuggestions", () => {
  const mentions = findUnlinkedMentions("GTD then Weekly Review.", candidates, "X.md");

  it("puts mention-backed suggestions first in document order, then related by score", () => {
    const s = buildSuggestions(mentions, [{ path: "Inbox.md", score: 0.8 }, { path: "Archive.md", score: 0.9 }], new Set());
    expect(s.map((x) => x.path)).toEqual(["GTD.md", "Weekly Review.md", "Archive.md", "Inbox.md"]);
    expect(s[0]!.reasons).toEqual(["mention"]);
    expect(s[2]!.reasons).toEqual(["related"]);
  });

  it("merges reasons when a mention target is also semantically related", () => {
    const s = buildSuggestions(mentions, [{ path: "GTD.md", score: 0.77 }], new Set());
    const gtd = s.find((x) => x.path === "GTD.md")!;
    expect(gtd.reasons).toEqual(["mention", "related"]);
    expect(gtd.score).toBe(0.77);
  });

  it("excludes targets the note already links to", () => {
    const s = buildSuggestions(mentions, [{ path: "GTD.md", score: 0.9 }], new Set(["GTD.md"]));
    expect(s.map((x) => x.path)).toEqual(["Weekly Review.md"]);
  });

  it("derives display names for related-only paths", () => {
    const s = buildSuggestions([], [{ path: "Projects/Deep Work.md", score: 0.5 }], new Set());
    expect(s[0]!.name).toBe("Deep Work");
  });
});

describe("mentionEdits", () => {
  it("produces plan-compatible unique edits that apply cleanly", () => {
    const content = "Intro line.\nGTD is the system.\nThen the Weekly Review happens.\n";
    const mentions = findUnlinkedMentions(content, candidates, "X.md");
    const edits = mentionEdits(content, mentions);
    const plan = planEdits(content, edits);
    const out = applyPlan(content, plan, plan.hunks.map(() => true));
    expect(out).toContain("[[GTD]] is the system.");
    expect(out).toContain("Then the [[Weekly Review]] happens.");
  });

  it("grows context until the line is unique", () => {
    const content = "same line\nsame line\nGTD here on a repeated neighbor\nsame line\n";
    const mentions = findUnlinkedMentions(content, candidates, "X.md");
    const edits = mentionEdits(content, mentions);
    expect(edits).toHaveLength(1);
    const plan = planEdits(content, edits);
    const out = applyPlan(content, plan, [true]);
    expect(out).toContain("[[GTD]] here on a repeated neighbor");
  });

  it("skips mentions that cannot be uniquified instead of producing ambiguous edits", () => {
    const content = "GTD\nGTD\n";
    // Both lines identical and mention detection returns first occurrence only;
    // old_str "GTD" appears twice and growing up hits file start — skip.
    const mentions = findUnlinkedMentions(content, candidates, "X.md");
    expect(mentionEdits(content, mentions)).toEqual([]);
  });
});
