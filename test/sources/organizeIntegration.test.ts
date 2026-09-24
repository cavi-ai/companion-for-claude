import { describe, expect, it } from "vitest";
import {
  currentDomainOf,
  inferDomains,
  planOrganizeMoves,
  resolveUnresolvedWithCurrentFolder,
  type OrganizeCandidate,
} from "../../src/sources/organize";

// Reproduces the real-vault defect: a 64-clip inbox already organized into
// Clippings/<topic>/ subfolders, then re-run through "Organize into folders"
// against a utility model whose batch reply gets truncated (no closing "]").
// Before the fix, every truncated chunk collapsed to misc; after the fix,
// truncation never produces a misc move — an already-filed clip keeps its
// folder, and a never-filed (root-level) clip is skipped, not misc'd.
describe("organize: truncated batch over a large already-organized inbox", () => {
  const topics = ["ai-agents", "ai-safety", "gaming", "llm-models", "llm-serving", "trading"];
  const organized = Array.from({ length: 60 }, (_, i) => {
    const topic = topics[i % topics.length]!;
    return { path: `Clippings/${topic}/clip-${i}.md`, title: `Clip ${i}`, summary: "s" };
  });
  const rootLevel = Array.from({ length: 4 }, (_, i) => ({
    path: `Clippings/new-clip-${i}.md`,
    title: `New clip ${i}`,
    summary: "s",
  }));
  const all = [...organized, ...rootLevel];
  function toCandidate(c: { path: string; title: string; summary: string }): OrganizeCandidate {
    const currentDomain = currentDomainOf(c.path, "Clippings");
    return { path: c.path, title: c.title, summary: c.summary, ...(currentDomain ? { currentDomain } : {}) };
  }
  const candidates = all.map(toCandidate);
  const currentDomains = new Map<string, string>();
  for (const c of all) {
    const currentDomain = currentDomainOf(c.path, "Clippings");
    if (currentDomain) currentDomains.set(c.path, currentDomain);
  }
  const titles = new Map(all.map((c) => [c.path, c.title]));

  it("never proposes misc — organized clips keep their folder, unfiled ones are skipped", async () => {
    const truncatedReply = "[" + candidates.map((c) => `{"path": "${c.path}", "domain": "misc"`).join(",");
    const complete = async (): Promise<string> => truncatedReply;

    const result = await inferDomains(candidates, { existingFolders: [], complete });
    expect(result.truncated).toBe(true);
    expect(result.unresolved).toHaveLength(64); // whole batch truncated, nothing resolved to misc

    const { proposals, skipped } = resolveUnresolvedWithCurrentFolder(result.unresolved, currentDomains);
    expect(proposals).toHaveLength(60); // every already-organized clip keeps its folder
    expect(skipped).toHaveLength(4); // the 4 never-filed root clips are excluded, not misc'd
    expect(proposals.some((p) => p.domain === "misc")).toBe(false);

    const moves = planOrganizeMoves(proposals, titles, {
      baseFolder: "Library",
      taken: () => false,
      existingFolders: topics,
    });
    expect(moves).toHaveLength(60);
    expect(moves.some((m) => m.domain === "misc")).toBe(false);
    for (const move of moves) expect(topics).toContain(move.domain);
  });

  it("an inbox with no prior organization at all hits the all-unresolved notice condition", async () => {
    const neverOrganized = rootLevel; // no currentDomain anywhere
    const complete = async (): Promise<string> => "[{\"path\": \"Clippings/new-clip-0.md\", \"domai"; // truncated
    const result = await inferDomains(neverOrganized, { existingFolders: [], complete });
    const { proposals, skipped } = resolveUnresolvedWithCurrentFolder(result.unresolved, new Map());
    expect(proposals).toHaveLength(0);
    expect(skipped).toHaveLength(neverOrganized.length); // every candidate skipped → main.ts takes the notice path
    expect(result.truncated).toBe(true);
  });
});
