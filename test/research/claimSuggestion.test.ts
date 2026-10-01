import { describe, expect, it } from "vitest";
import { buildClaimSuggestionRequest, claimSuggestionEvidence, parseClaimSuggestion } from "../../src/research/claimSuggestion";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";

const offered = new Set(["E/a.md", "E/b.md"]);

describe("parseClaimSuggestion", () => {
  it("reads fenced JSON with surrounding prose", () => {
    const raw = "Here you go:\n```json\n{\"title\":\" Switching costs \",\"proposition\":\"Switching delays focus.\",\"confidence\":\"high\",\"relations\":[{\"evidence\":\"E/a.md\",\"relation\":\"supports\"},{\"evidence\":\"E/b.md\",\"relation\":\"challenges\"}]}\n```\nHope that helps.";
    expect(parseClaimSuggestion(raw, offered)).toEqual({ title: "Switching costs", proposition: "Switching delays focus.", confidence: "high", relations: { "E/a.md": "supports", "E/b.md": "challenges" } });
  });
  it("drops unknown paths and invalid relations, defaults confidence", () => {
    const raw = JSON.stringify({ title: "T", proposition: "P.", confidence: "certain", relations: [{ evidence: "E/zzz.md", relation: "supports" }, { evidence: "E/a.md", relation: "agrees" }, { evidence: "E/b.md", relation: "contextualizes" }] });
    expect(parseClaimSuggestion(raw, offered)).toEqual({ title: "T", proposition: "P.", confidence: "moderate", relations: { "E/b.md": "contextualizes" } });
  });
  it("trims a long title at a word boundary", () => {
    const title = parseClaimSuggestion(JSON.stringify({ title: "word ".repeat(30), proposition: "P." }), offered)!.title;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("word")).toBe(true);
  });
  it("returns null without a title or proposition, or without JSON", () => {
    expect(parseClaimSuggestion(JSON.stringify({ title: "T" }), offered)).toBeNull();
    expect(parseClaimSuggestion(JSON.stringify({ proposition: "P" }), offered)).toBeNull();
    expect(parseClaimSuggestion("no json here", offered)).toBeNull();
  });
});

describe("claimSuggestionEvidence", () => {
  const project = { path: "R/P.md", title: "P", type: "research-project", project: "R/P.md", question: "Q?", stage: "read", status: "active" } as const;
  const ev = (name: string, reviewState: "reviewed" | "proposed"): ResearchRecord => ({ path: `R/E/${name}.md`, title: name, type: "evidence", project: project.path, source: "R/S.md", excerpt: "x", reviewState });
  const claim: ResearchRecord = { path: "R/C.md", title: "C", type: "claim", project: project.path, proposition: "p", confidence: "low", reviewState: "proposed", supports: ["R/E/a.md"], challenges: [], contextualizes: [], limitations: [] };
  it("prefers reviewed evidence no claim uses, else all reviewed", () => {
    const one = buildProjectSnapshot(project.path, [project, ev("a", "reviewed"), ev("b", "reviewed"), ev("c", "proposed"), claim], []);
    expect(claimSuggestionEvidence(one).map(({ title }) => title)).toEqual(["b"]);
    const two = buildProjectSnapshot(project.path, [project, ev("a", "reviewed"), claim], []);
    expect(claimSuggestionEvidence(two).map(({ title }) => title)).toEqual(["a"]);
  });
});

describe("buildClaimSuggestionRequest", () => {
  it("lists every passage path", () => {
    const { user, system } = buildClaimSuggestionRequest("Q?", [{ path: "E/a.md", title: "A", excerpt: "text" }]);
    expect(user).toContain("E/a.md");
    expect(system).toContain("JSON");
  });
});
