import { describe, expect, it } from "vitest";
import { researchContinuationStep, recordBasename } from "../../src/research/nextStep";
import { buildProjectSnapshot } from "../../src/research/graph";
import type { ResearchRecord } from "../../src/research/types";

const project = { path: "Research/Project.md", title: "P", type: "research-project", project: "Research/Project.md", question: "Q?", stage: "read", status: "active" } as const;

function snapshot(records: ResearchRecord[] = []) {
  return buildProjectSnapshot(project.path, [project, ...records], []);
}

const source = { path: "Research/Sources/S1.md", title: "S1", type: "research-source" as const, project: project.path, sourceKind: "web" as const };
const evidence = { path: "Research/Evidence/E1.md", title: "E1", type: "evidence" as const, project: project.path, source: source.path, excerpt: "Text", reviewState: "reviewed" as const };
const claim = { path: "Research/Claims/C1.md", title: "C1", type: "claim" as const, project: project.path, proposition: "P1", confidence: "moderate" as const, reviewState: "reviewed" as const, supports: [], challenges: [], contextualizes: [], limitations: [] };

describe("researchContinuationStep", () => {
  it("walks the pipeline in order", () => {
    expect(researchContinuationStep(snapshot()).step).toBe("add-source");
    expect(researchContinuationStep(snapshot([source])).step).toBe("create-evidence");
    expect(researchContinuationStep(snapshot([source])).path).toBe(source.path);
    expect(researchContinuationStep(snapshot([source, evidence])).step).toBe("create-claim");
    expect(researchContinuationStep(snapshot([source, evidence, claim])).step).toBe("build-outline");
  });

  it("continues to draft and assurance once documents exist", () => {
    const outline = { path: "Research/Documents/Outline.md", title: "O", type: "research-document" as const, project: project.path, documentKind: "outline" as const, sections: [] };
    const draft = { path: "Research/Documents/Draft.md", title: "D", type: "research-document" as const, project: project.path, documentKind: "draft" as const, sections: [] };
    expect(researchContinuationStep(snapshot([source, evidence, claim, outline]))).toEqual({ step: "continue-outline", path: outline.path });
    expect(researchContinuationStep(snapshot([source, evidence, claim, outline, draft]))).toEqual({ step: "assure-document", path: draft.path });
  });
});

describe("recordBasename", () => {
  it("strips folder and extension (case-insensitive)", () => {
    expect(recordBasename("Research/Evidence/E1.md")).toBe("E1");
    expect(recordBasename("Loose.MD")).toBe("Loose");
  });
});
