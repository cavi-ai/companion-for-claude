import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { passageContext, pickClaimForReview, pickEvidenceForReview } from "../../src/research/reviewTargets";
import type { ResearchRecord } from "../../src/research/types";

const project = { path: "R/P.md", title: "P", type: "research-project", project: "R/P.md", question: "Q?", stage: "read", status: "active" } as const;
const source: ResearchRecord = { path: "R/S.md", title: "S", type: "research-source", project: project.path, sourceKind: "web", contentFingerprint: "new", capturedContent: "Before the passage. The exact passage lives here. After it." };
const ev = (name: string, extra: Record<string, unknown> = {}): ResearchRecord => ({ path: `R/E/${name}.md`, title: name, type: "evidence", project: project.path, source: source.path, excerpt: "The exact passage lives here.", locatorKind: "page", locatorValue: "1", reviewState: "reviewed", ...extra }) as ResearchRecord;

describe("pickEvidenceForReview", () => {
  it("opens the named path, else proposed, stale, then unlocated", () => {
    const snap = buildProjectSnapshot(project.path, [project, source, ev("a", { sourceFingerprint: "old" }), ev("b", { locatorKind: undefined, locatorValue: undefined }), ev("c", { reviewState: "proposed" })], []);
    expect(pickEvidenceForReview(snap, "R/E/b.md")?.title).toBe("b");
    expect(pickEvidenceForReview(snap)?.title).toBe("c");
    const noProposed = buildProjectSnapshot(project.path, [project, source, ev("a", { sourceFingerprint: "old" }), ev("b", { locatorKind: undefined, locatorValue: undefined })], []);
    expect(pickEvidenceForReview(noProposed)?.title).toBe("a");
    const onlyUnlocated = buildProjectSnapshot(project.path, [project, source, ev("b", { locatorKind: undefined, locatorValue: undefined })], []);
    expect(pickEvidenceForReview(onlyUnlocated)?.title).toBe("b");
  });
});

describe("pickClaimForReview", () => {
  it("opens the named claim, else the first needing a check", () => {
    const claim = (name: string, extra: Record<string, unknown> = {}): ResearchRecord => ({ path: `R/C/${name}.md`, title: name, type: "claim", project: project.path, proposition: "p", confidence: "low", reviewState: "reviewed", supports: [], challenges: [], contextualizes: [], limitations: [], ...extra }) as ResearchRecord;
    const snap = buildProjectSnapshot(project.path, [project, claim("a"), claim("b", { reviewState: "proposed" })], []);
    expect(pickClaimForReview(snap, "R/C/a.md")?.title).toBe("a");
    expect(pickClaimForReview(snap)?.title).toBe("b");
  });
});

describe("passageContext", () => {
  it("returns the surrounding text, null when gone, undefined without text", () => {
    expect(passageContext(source as never, "The exact   passage lives here.")).toContain("Before the passage.");
    expect(passageContext(source as never, "Something else entirely")).toBeNull();
    expect(passageContext({ ...source, sourceKind: "pdf" } as never, "x")).toBeUndefined();
    expect(passageContext({ ...source, capturedContent: undefined } as never, "x")).toBeUndefined();
  });
});
