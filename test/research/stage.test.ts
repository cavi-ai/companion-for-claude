import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { deriveResearchStage } from "../../src/research/stage";
import type { ResearchRecord } from "../../src/research/types";

const P = "R/Project.md";
const project = (question: string): ResearchRecord => ({ path: P, title: "P", type: "research-project", project: P, question, stage: "frame", status: "active" });
const source: ResearchRecord = { path: "R/Sources/S.md", title: "S", type: "research-source", project: P, sourceKind: "web" };
const evidence: ResearchRecord = { path: "R/Evidence/E.md", title: "E", type: "evidence", project: P, source: "R/Sources/S.md", locatorKind: "page", locatorValue: "1", excerpt: "x", reviewState: "reviewed" };
const claim: ResearchRecord = { path: "R/Claims/C.md", title: "C", type: "claim", project: P, proposition: "p", confidence: "high", reviewState: "reviewed", supports: ["R/Evidence/E.md"], challenges: [], contextualizes: [], limitations: [] };
const document: ResearchRecord = { path: "R/Documents/Outline.md", title: "O", type: "research-document", project: P, documentKind: "outline", claims: ["R/Claims/C.md"] };
const snap = (...records: ResearchRecord[]) => buildProjectSnapshot(P, records, []);

describe("deriveResearchStage", () => {
  it("walks the stages from the notes, ignoring the stored stage", () => {
    expect(deriveResearchStage(snap(project(" ")))).toBe("frame");
    expect(deriveResearchStage(snap(project("Q?")))).toBe("gather");
    expect(deriveResearchStage(snap(project("Q?"), source))).toBe("read");
    expect(deriveResearchStage(snap(project("Q?"), source, evidence))).toBe("reason");
    expect(deriveResearchStage(snap(project("Q?"), source, evidence, claim))).toBe("shape");
    expect(deriveResearchStage(snap(project("Q?"), source, evidence, claim, document))).toBe("write");
    expect(deriveResearchStage(snap(project("Q?"), source, evidence, claim, document), ["drafted", "outline"])).toBe("write");
    expect(deriveResearchStage(snap(project("Q?"), source, evidence, claim, document), ["drafted", "drafted"])).toBe("assure");
  });
});
