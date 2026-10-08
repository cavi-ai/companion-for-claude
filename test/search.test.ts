import { describe, it, expect } from "vitest";
import { tokenize, clip, snippetAround, termStats, bm25Score, matchesAny, section } from "../src/context/search";

describe("tokenize", () => {
  it("lowercases, drops short words and stopwords, strips punctuation, dedupes", () => {
    expect(tokenize("The Quick, quick brown fox!")).toEqual(["quick", "brown", "fox"]);
  });
  it("ignores words shorter than 3 chars and stopwords", () => {
    expect(tokenize("a an to the")).toEqual([]);
    expect(tokenize("what did I decide about the pricing")).toEqual(["decide", "pricing"]);
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

describe("termStats", () => {
  it("counts body matches per term and finds the first index", () => {
    const s = termStats(["alpha", "beta"], "Notes/Alpha.md", "#beta #project", "the alpha keyword appears here ALPHA");
    expect(s).toEqual({ counts: [2, 0], inPath: [true, false], inTags: [false, true], length: 36, firstIdx: "the ".length });
    expect(matchesAny(s)).toBe(true);
    expect(matchesAny(termStats(["zzz"], "a.md", "", "nothing here"))).toBe(false);
  });

  it("keeps the first index aligned when a character's lowercase is longer (İ)", () => {
    const content = "İstanbul trip: pricing notes";
    expect(termStats(["pricing"], "a.md", "", content).firstIdx).toBe(content.indexOf("pricing"));
  });
});

describe("bm25Score", () => {
  const corpus = { docs: 100, avgLength: 1000, df: [2, 90] };

  it("weights a rare term above a common one", () => {
    const rare = bm25Score({ counts: [1, 0], inPath: [false, false], inTags: [false, false], length: 1000, firstIdx: 0 }, corpus);
    const common = bm25Score({ counts: [0, 1], inPath: [false, false], inTags: [false, false], length: 1000, firstIdx: 0 }, corpus);
    expect(rare).toBeGreaterThan(common * 5);
  });

  it("saturates repetition and normalizes by length", () => {
    const at = (count: number, length: number) => bm25Score({ counts: [count, 0], inPath: [false, false], inTags: [false, false], length, firstIdx: 0 }, corpus);
    expect(at(50, 1000) / at(1, 1000)).toBeLessThan(2.5);
    expect(at(1, 200)).toBeGreaterThan(at(1, 20_000));
  });

  it("boosts title over tag over body", () => {
    const base = { counts: [0, 0], inPath: [false, false], inTags: [false, false], length: 1000, firstIdx: -1 };
    const title = bm25Score({ ...base, inPath: [true, false] }, corpus);
    const tag = bm25Score({ ...base, inTags: [true, false] }, corpus);
    const body = bm25Score({ ...base, counts: [1, 0] }, corpus);
    expect(title).toBeGreaterThan(tag);
    expect(tag).toBeGreaterThan(body);
  });
});

describe("section", () => {
  it("formats a titled block", () => {
    expect(section("Title", "body")).toBe("### Title\nbody");
  });
});
