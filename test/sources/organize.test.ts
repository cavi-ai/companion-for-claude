import { describe, expect, it } from "vitest";
import { buildOrganizePrompt, inferDomains, parseOrganizeResponse, planOrganizeMoves, relativeFolders, sanitizeDomain } from "../../src/sources/organize";

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
  it("maps model output to candidates by path, sanitizing domains; unmatched candidates are unresolved", () => {
    const raw = `Here's the grouping:\n\`\`\`json\n[
      {"path": "Clippings/clip 2024-05-01 abc123.md", "domain": "Local First"},
      {"path": "Clippings/export (3).md", "domain": "AI Research"}
    ]\n\`\`\``;
    const { proposals, unresolved } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([
      { path: candidates[0]!.path, domain: "local-first" },
      { path: candidates[1]!.path, domain: "ai-research" },
    ]);
    expect(unresolved).toEqual([candidates[2]!.path]);
  });

  it("accepts a bare single-object reply (llama3.1 in the wild)", () => {
    const raw = '{"path": "Clippings/clip 2024-05-01 abc123.md", "domain": "local-first"}';
    const { proposals, unresolved } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([{ path: candidates[0]!.path, domain: "local-first" }]);
    expect(unresolved).toEqual([candidates[1]!.path, candidates[2]!.path]);
  });

  it("treats garbage as unresolved, never misc", () => {
    const { proposals, unresolved } = parseOrganizeResponse("no json here", candidates);
    expect(proposals).toEqual([]);
    expect(unresolved).toEqual(candidates.map((c) => c.path));
  });

  it("a reply whose array is never closed is truncated — every candidate unresolved, none misc", () => {
    const raw = `[
      {"path": "Clippings/clip 2024-05-01 abc123.md", "domain": "local-first"},
      {"path": "Clippings/export (3).md", "domai`; // cut off mid-object, no closing ]
    const { proposals, unresolved } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([]);
    expect(unresolved).toEqual(candidates.map((c) => c.path));
  });

  it("matches by basename when the model drops the folder prefix", () => {
    const raw = '[{"path": "export (3).md", "domain": "ai-research"}]';
    const { proposals, unresolved } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([{ path: candidates[1]!.path, domain: "ai-research" }]);
    expect(unresolved).toEqual([candidates[0]!.path, candidates[2]!.path]);
  });

  it("matches positionally when the reply has exactly one object per candidate but no usable path", () => {
    const raw = '[{"domain": "local-first"}, {"domain": "ai-research"}, {"domain": "gardening"}]';
    const { proposals, unresolved } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([
      { path: candidates[0]!.path, domain: "local-first" },
      { path: candidates[1]!.path, domain: "ai-research" },
      { path: candidates[2]!.path, domain: "gardening" },
    ]);
    expect(unresolved).toEqual([]);
  });

  it("does not match positionally when the reply count differs from the candidate count", () => {
    const raw = '[{"domain": "local-first"}, {"domain": "ai-research"}]';
    const { proposals, unresolved } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([]);
    expect(unresolved).toEqual(candidates.map((c) => c.path));
  });

  it("keeps misc only when the model wrote it", () => {
    const raw = '[{"path": "Clippings/untitled.md", "domain": "misc"}]';
    const { proposals } = parseOrganizeResponse(raw, candidates);
    expect(proposals).toEqual([{ path: candidates[2]!.path, domain: "misc" }]);
  });
});

describe("inferDomains", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    path: `Clippings/clip-${i}.md`,
    title: `Clip ${i}`,
    summary: "summary",
  }));

  it("chunks 40 candidates into 16/16/8 calls, each seeing earlier chunks' chosen domains", async () => {
    const chunkLens: number[] = [];
    const seenExisting: string[][] = [];
    let call = 0;
    const complete = async (system: string, user: string): Promise<string> => {
      chunkLens.push(user.match(/- path:/g)?.length ?? 0);
      const existingBlock = system.split("Existing folders to prefer when relevant:\n")[1] ?? "";
      seenExisting.push(existingBlock.split("\n").filter(Boolean));
      call++;
      // First chunk resolves one clip to a fresh domain so the second chunk should see it.
      return call === 1 ? JSON.stringify([{ path: "Clippings/clip-0.md", domain: "fresh-domain" }]) : "[]";
    };
    const result = await inferDomains(many, { existingFolders: ["ai-research"], complete, chunkSize: 16 });
    expect(chunkLens).toEqual([16, 16, 8]);
    expect(seenExisting[0]).toEqual(["- ai-research"]);
    expect(seenExisting[1]).toEqual(["- ai-research", "- fresh-domain"]);
    expect(result.proposals).toEqual([{ path: "Clippings/clip-0.md", domain: "fresh-domain" }]);
  });

  it("truncated reply → all unresolved, none misc", async () => {
    const complete = async (): Promise<string> => "[{\"path\": \"Clippings/clip-0.md\", \"domain\"";
    const result = await inferDomains(many.slice(0, 3), { existingFolders: [], complete });
    expect(result.proposals).toEqual([]);
    expect(result.unresolved).toEqual(many.slice(0, 3).map((c) => c.path));
    expect(result.truncated).toBe(true);
  });

  it("misc only appears when the model says so", async () => {
    const two = many.slice(0, 2);
    const complete = async (): Promise<string> =>
      JSON.stringify([
        { path: two[0]!.path, domain: "ai-research" },
        { path: two[1]!.path, domain: "misc" },
      ]);
    const result = await inferDomains(two, { existingFolders: [], complete });
    expect(result.proposals).toEqual([
      { path: two[0]!.path, domain: "ai-research" },
      { path: two[1]!.path, domain: "misc" },
    ]);
    expect(result.unresolved).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("sets maxTokens per call to 64 + 96 * chunk length", async () => {
    const seen: number[] = [];
    const complete = async (_s: string, _u: string, maxTokens: number): Promise<string> => {
      seen.push(maxTokens);
      return "[]";
    };
    await inferDomains(many, { existingFolders: [], complete, chunkSize: 16 });
    expect(seen).toEqual([64 + 96 * 16, 64 + 96 * 16, 64 + 96 * 8]);
  });

  it("a rejecting complete() yields all unresolved and records the rejection message as lastError", async () => {
    const three = many.slice(0, 3);
    const complete = async (): Promise<string> => {
      throw new Error("network error");
    };
    const result = await inferDomains(three, { existingFolders: [], complete });
    expect(result.proposals).toEqual([]);
    expect(result.unresolved).toEqual(three.map((c) => c.path));
    expect(result.lastError).toBe("network error");
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

describe("relativeFolders", () => {
  it("keeps only paths under base, made relative, sorted and deduped", () => {
    expect(relativeFolders(["Library/AI", "Library/AI/ml", "Other/x", "Library"], "Library")).toEqual(["AI", "AI/ml"]);
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

  it("uses an existing folder's own casing/spelling when its sanitized form matches the domain", () => {
    const proposal = [{ path: candidates[0]!.path, domain: "ai-tools" }];
    const moves = planOrganizeMoves(proposal, titles, { baseFolder: "Library", taken: () => false, existingFolders: ["AI Tools"] });
    expect(moves[0]!.to).toBe(`Library/AI Tools/${candidates[0]!.title}.md`);
  });

  it("matches a single-word existing folder too", () => {
    const proposal = [{ path: candidates[0]!.path, domain: "research" }];
    const moves = planOrganizeMoves(proposal, titles, { baseFolder: "Library", taken: () => false, existingFolders: ["Research"] });
    expect(moves[0]!.to).toBe(`Library/Research/${candidates[0]!.title}.md`);
  });

  it("keeps the lowercase domain when no existing folder matches", () => {
    const proposal = [{ path: candidates[0]!.path, domain: "ai-tools" }];
    const moves = planOrganizeMoves(proposal, titles, { baseFolder: "Library", taken: () => false, existingFolders: ["Other"] });
    expect(moves[0]!.to).toBe(`Library/ai-tools/${candidates[0]!.title}.md`);
  });

  it("canonicalizes a 2-segment domain segment by segment against existing folders", () => {
    const existingFolders = ["AI", "AI/ML Papers"];
    const cases: Array<[string, string]> = [
      ["ai/ml-papers", "AI/ML Papers"],
      ["ai/new-topic", "AI/new-topic"],
      ["gardening", "gardening"],
    ];
    for (const [domain, expectedDir] of cases) {
      const proposal = [{ path: candidates[0]!.path, domain }];
      const moves = planOrganizeMoves(proposal, titles, { baseFolder: "Library", taken: () => false, existingFolders });
      expect(moves[0]!.to).toBe(`Library/${expectedDir}/${candidates[0]!.title}.md`);
    }
  });
});
