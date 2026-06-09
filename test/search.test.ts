import { describe, it, expect } from "vitest";
import { tokenize, clip, snippetAround, scoreContent, section } from "../src/context/search";

describe("tokenize", () => {
  it("lowercases, drops short words, strips punctuation, dedupes", () => {
    expect(tokenize("The Quick, quick brown fox!")).toEqual(["the", "quick", "brown", "fox"]);
  });
  it("ignores words shorter than 3 chars", () => {
    expect(tokenize("a an to the")).toEqual(["the"]);
  });
  it("caps at 12 terms", () => {
    const q = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
    expect(tokenize(q).length).toBe(12);
  });
});

describe("clip", () => {
  it("returns text unchanged when within budget", () => {
    expect(clip("hello", 10)).toBe("hello");
  });
  it("truncates and marks when over budget", () => {
    expect(clip("hello world", 5)).toBe("hello\n…[truncated]");
  });
  it("returns empty string for non-positive budget", () => {
    expect(clip("hello", 0)).toBe("");
  });
});

describe("snippetAround", () => {
  it("returns the head when there is no match", () => {
    const text = "x".repeat(1000);
    expect(snippetAround(text, -1)).toBe("x".repeat(600));
  });
  it("windows around the match with ellipses", () => {
    const text = "A".repeat(300) + "TARGET" + "B".repeat(800);
    const snip = snippetAround(text, 300);
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain("TARGET");
  });
});

describe("scoreContent", () => {
  it("weights path > tags > body and finds the first index", () => {
    const r = scoreContent(["alpha"], "notes/alpha.md", "", "the alpha keyword appears here alpha");
    // path(3) + body(2 occurrences) = 5
    expect(r.score).toBe(5);
    expect(r.firstIdx).toBe("the ".length);
  });
  it("adds tag weight", () => {
    const r = scoreContent(["beta"], "notes/x.md", "#beta #project", "no body match");
    expect(r.score).toBe(2);
    expect(r.firstIdx).toBe(-1);
  });
  it("scores zero when nothing matches", () => {
    expect(scoreContent(["zzz"], "a.md", "", "nothing here")).toEqual({ score: 0, firstIdx: -1 });
  });
});

describe("section", () => {
  it("formats a titled block", () => {
    expect(section("Title", "body")).toBe("### Title\nbody");
  });
});
