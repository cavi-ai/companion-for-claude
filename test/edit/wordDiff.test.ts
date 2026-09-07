import { describe, expect, it } from "vitest";
import { tokenize, wordDiff, type Span } from "../../src/edit/wordDiff";

const rebuild = (spans: Span[], keep: "del" | "add"): string =>
  spans.filter((s) => s.kind === "same" || s.kind === keep).map((s) => s.text).join("");

describe("tokenize", () => {
  it("keeps words and whitespace runs as separate tokens", () => {
    expect(tokenize("the  quick\nfox")).toEqual(["the", "  ", "quick", "\n", "fox"]);
  });
  it("returns nothing for the empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("wordDiff", () => {
  it("returns one same span for identical text and nothing for two empties", () => {
    expect(wordDiff("a b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("isolates a single changed word", () => {
    expect(wordDiff("the quick fox", "the slow fox")).toEqual([
      { kind: "same", text: "the " },
      { kind: "del", text: "quick" },
      { kind: "add", text: "slow" },
      { kind: "same", text: " fox" },
    ]);
  });

  it("puts every deletion before every insertion inside one changed run", () => {
    // The shared space between the two changed words survives as its own "same" span.
    expect(wordDiff("one two three four", "one 2 3 four")).toEqual([
      { kind: "same", text: "one " },
      { kind: "del", text: "two" },
      { kind: "add", text: "2" },
      { kind: "same", text: " " },
      { kind: "del", text: "three" },
      { kind: "add", text: "3" },
      { kind: "same", text: " four" },
    ]);
    expect(wordDiff("alpha beta", "gamma delta")).toEqual([
      { kind: "del", text: "alpha" },
      { kind: "add", text: "gamma" },
      { kind: "same", text: " " },
      { kind: "del", text: "beta" },
      { kind: "add", text: "delta" },
    ]);
  });

  it("handles pure insertion and pure deletion at the ends", () => {
    expect(wordDiff("a b", "a b c")).toEqual([{ kind: "same", text: "a b" }, { kind: "add", text: " c" }]);
    expect(wordDiff("x a b", "a b")).toEqual([{ kind: "del", text: "x " }, { kind: "same", text: "a b" }]);
  });

  it("treats a whitespace-only change as a change", () => {
    expect(wordDiff("a b", "a  b")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: " " },
      { kind: "add", text: "  " },
      { kind: "same", text: "b" },
    ]);
  });

  it("reconstructs both sides across multi-line input", () => {
    const a = "- [ ] Create the parser\n- [ ] Wire the interface\n";
    const b = "- [ ] Create the tokenizer\n- [x] Wire the interface\n";
    const spans = wordDiff(a, b);
    expect(rebuild(spans, "del")).toBe(a);
    expect(rebuild(spans, "add")).toBe(b);
    expect(spans.every((s) => s.text.length > 0)).toBe(true);
    // Coalesced: adjacent spans never share a kind.
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]!.kind).not.toBe(spans[i - 1]!.kind);
  });

  it("falls back to one coarse replacement above the cell budget", () => {
    const a = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 1200 }, (_, i) => `v${i}`).join(" ");
    expect(wordDiff(a, b)).toEqual([{ kind: "del", text: a }, { kind: "add", text: b }]);
  });
});
