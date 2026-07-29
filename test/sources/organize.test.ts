import { describe, expect, it } from "vitest";
import { buildOrganizePrompt, parseOrganizeResponse, planOrganizeMoves, sanitizeDomain } from "../../src/sources/organize";

const candidates = [
  { path: "Clippings/clip 2024-05-01 abc123.md", title: "Why local-first note apps are winning", summary: "Local-first software keeps data on-device." },
  { path: "Clippings/export (3).md", title: "Attention Is All You Need", summary: "The transformer architecture paper." },
  { path: "Clippings/untitled.md", title: "Tomato trellis guide", summary: "How to stake indeterminate tomatoes." },
];

describe("buildOrganizePrompt", () => {
  it("lists every clip and the existing folders to prefer", () => {
    const { system, user } = buildOrganizePrompt(candidates, ["Library/ai-research", "Library/gardening"]);
    expect(system).toContain("Library/ai-research");
    expect(system).toMatch(/same order/i);
    expect(user).toContain("Attention Is All You Need");
    expect(user).toContain("Clippings/untitled.md");
  });
});

describe("parseOrganizeResponse", () => {
  it("maps model output to candidates, sanitizing domains and defaulting misc", () => {
    const raw = `Here's the grouping:\n\`\`\`json\n[
      {"path": "Clippings/clip 2024-05-01 abc123.md", "domain": "Local First"},
      {"path": "Clippings/export (3).md", "domain": "AI Research"}
    ]\n\`\`\``;
    const proposals = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([
      { path: candidates[0]!.path, domain: "local-first" },
      { path: candidates[1]!.path, domain: "ai-research" },
      { path: candidates[2]!.path, domain: "misc" },
    ]);
  });

  it("accepts a bare single-object reply (llama3.1 in the wild)", () => {
    const raw = '{"path": "Clippings/clip 2024-05-01 abc123.md", "domain": "local-first"}';
    const proposals = parseOrganizeResponse(raw, candidates);
    expect(proposals[0]).toEqual({ path: candidates[0]!.path, domain: "local-first" });
    expect(proposals[1]!.domain).toBe("misc");
  });

  it("falls back to misc for the whole batch on garbage", () => {
    expect(parseOrganizeResponse("no json here", candidates).map((p) => p.domain)).toEqual(["misc", "misc", "misc"]);
  });
});

describe("sanitizeDomain", () => {
  it("normalizes case, separators, and depth", () => {
    expect(sanitizeDomain("AI Research")).toBe("ai-research");
    expect(sanitizeDomain("research/continuity theory/extra")).toBe("research/continuity-theory");
    expect(sanitizeDomain("  ///  ")).toBe("misc");
    expect(sanitizeDomain("weird@@@name")).toBe("weird-name");
  });
});

describe("planOrganizeMoves", () => {
  const titles = new Map(candidates.map((c) => [c.path, c.title]));
  const proposals = [
    { path: candidates[0]!.path, domain: "local-first" },
    { path: candidates[1]!.path, domain: "ai-research" },
    { path: candidates[2]!.path, domain: "gardening" },
  ];

  it("moves and renames into <base>/<domain>/<Title>.md with collision suffixes", () => {
    const taken = (p: string) => p === "Library/local-first/Why local-first note apps are winning.md"; // first name already exists
    const moves = planOrganizeMoves(proposals, titles, { baseFolder: "Library", taken });
    expect(moves).toEqual([
      { from: candidates[0]!.path, to: "Library/local-first/Why local-first note apps are winning 2.md", title: candidates[0]!.title, domain: "local-first" },
      { from: candidates[1]!.path, to: "Library/ai-research/Attention Is All You Need.md", title: candidates[1]!.title, domain: "ai-research" },
      { from: candidates[2]!.path, to: "Library/gardening/Tomato trellis guide.md", title: candidates[2]!.title, domain: "gardening" },
    ]);
  });

  it("skips clips already at their destination", () => {
    const home = "Library/gardening/Tomato trellis guide.md";
    const moves = planOrganizeMoves([{ path: home, domain: "gardening" }], titles, { baseFolder: "Library", taken: () => true });
    expect(moves).toEqual([]);
  });

  it("two clips with the same title in one batch get distinct names", () => {
    const dup = [
      { path: "Clippings/a.md", domain: "x" },
      { path: "Clippings/b.md", domain: "x" },
    ];
    const dupTitles = new Map([
      ["Clippings/a.md", "Same Title"],
      ["Clippings/b.md", "Same Title"],
    ]);
    const moves = planOrganizeMoves(dup, dupTitles, { baseFolder: "Library", taken: () => false });
    expect(moves.map((m) => m.to)).toEqual(["Library/x/Same Title.md", "Library/x/Same Title 2.md"]);
  });
});
