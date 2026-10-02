import { describe, expect, it } from "vitest";
import { auditProject } from "../../src/research/audit";
import { buildArgument, claimOrder } from "../../src/research/argument";
import { buildProjectSnapshot } from "../../src/research/graph";
import { analyzeProjectIntelligence } from "../../src/research/intelligence";
import type { ClaimRecord, ResearchRecord } from "../../src/research/types";

const P = "R/Project.md";
const base: ResearchRecord[] = [
  { path: P, title: "P", type: "research-project", project: P, question: "Q?", stage: "frame", status: "active" },
  { path: "R/Sources/S.md", title: "Source S", type: "research-source", project: P, sourceKind: "web" },
  { path: "R/Sources/Unread.md", title: "Unread", type: "research-source", project: P, sourceKind: "web" },
  ...["E1", "E2", "E3"].map((name): ResearchRecord => ({ path: `R/Evidence/${name}.md`, title: name, type: "evidence", project: P, source: "R/Sources/S.md", locatorKind: "page", locatorValue: "1", excerpt: name, reviewState: "reviewed" })),
  { path: "R/Evidence/Proposed.md", title: "Proposed", type: "evidence", project: P, source: "R/Sources/S.md", locatorKind: "page", locatorValue: "2", excerpt: "p", reviewState: "proposed" },
  { path: "R/Evidence/Loose.md", title: "Loose", type: "evidence", project: P, source: "R/Sources/S.md", locatorKind: "page", locatorValue: "3", excerpt: "l", reviewState: "reviewed" },
];
const claim = (name: string, over: Partial<ClaimRecord> = {}): ClaimRecord => ({ path: `R/Claims/${name}.md`, title: name, type: "claim", project: P, proposition: `${name} holds.`, confidence: "moderate", reviewState: "reviewed", supports: ["R/Evidence/E1.md", "R/Evidence/E2.md"], challenges: [], contextualizes: [], limitations: [], ...over });
const model = (claims: ClaimRecord[], extra: ResearchRecord[] = [], sections?: Parameters<typeof buildArgument>[3]) => {
  const snapshot = buildProjectSnapshot(P, [...base, ...claims, ...extra], []);
  return buildArgument(snapshot, auditProject(snapshot), analyzeProjectIntelligence(snapshot), sections);
};
const status = (argument: ReturnType<typeof model>) => Object.fromEntries([...argument.cards, ...argument.rejected].map(({ title, status: value }) => [title, value]));

describe("buildArgument", () => {
  it("assigns one status per claim, first match wins", () => {
    const argument = model([
      claim("Rejected", { reviewState: "rejected" }),
      claim("Proposed", { reviewState: "proposed" }),
      claim("Unsupported", { supports: ["R/Evidence/Proposed.md"] }),
      claim("Thin", { supports: ["R/Evidence/E1.md"] }),
      claim("Challenged", { challenges: ["R/Evidence/E3.md"] }),
      claim("Answered", { challenges: ["R/Evidence/E3.md"], limitations: ["Scope"] }),
    ]);
    expect(status(argument)).toEqual({ Rejected: "rejected", Proposed: "needs-check", Unsupported: "unsupported", Thin: "thin", Challenged: "challenged", Answered: "ready" });
    expect(argument.rejected.map(({ title }) => title)).toEqual(["Rejected"]);
    expect(argument.cards.find(({ title }) => title === "Challenged")?.notes[0]).toMatch(/pushes back/);
  });

  it("reads outline membership and section state", () => {
    const outline: ResearchRecord = { path: "R/Documents/Outline.md", title: "Outline", type: "research-document", project: P, documentKind: "outline", claims: ["R/Claims/B.md", "R/Claims/A.md", "R/Claims/C.md"] };
    const argument = model([claim("A"), claim("B"), claim("C"), claim("D")], [outline], [
      { id: "b", heading: "B", claimPath: "R/Claims/B.md", state: "drafted" },
      { id: "a", heading: "A", claimPath: "R/Claims/A.md", state: "changed" },
      { id: "c", heading: "C", claimPath: "R/Claims/C.md", state: "outline" },
    ]);
    expect(argument.cards.map(({ title, status: value }) => [title, value])).toEqual([["B", "drafted"], ["A", "changed"], ["C", "not-drafted"], ["D", "not-in-outline"]]);
  });

  it("lists passages with flags, unused passages and unread sources", () => {
    const argument = model([claim("A", { supports: ["R/Evidence/E1.md", "R/Evidence/Proposed.md", "R/Evidence/Missing.md"] })]);
    const card = argument.cards[0]!;
    expect(card.passages.map(({ title, flag, trusted, locator }) => ({ title, flag, trusted, locator }))).toEqual([
      { title: "E1", flag: undefined, trusted: true, locator: "page 1" },
      { title: "Missing", flag: "missing", trusted: false, locator: undefined },
      { title: "Proposed", flag: "unchecked", trusted: false, locator: "page 2" },
    ]);
    expect(argument.unusedPassages.map(({ title }) => title)).toEqual(["E2", "E3", "Loose"]);
    expect(argument.unreadSources.map(({ title }) => title)).toEqual(["Unread"]);
    expect(argument.fixFirst.map(({ code }) => code)).toEqual(["broken-reference"]);
  });

  it("orders claims by outline then path", () => {
    const outline: ResearchRecord = { path: "R/Documents/Outline.md", title: "Outline", type: "research-document", project: P, documentKind: "outline", claims: ["R/Claims/Z.md"] };
    const snapshot = buildProjectSnapshot(P, [...base, claim("A"), claim("Z"), outline], []);
    expect(claimOrder(snapshot).map(({ title }) => title)).toEqual(["Z", "A"]);
  });
});
