import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { auditProject } from "../../src/research/audit";
import type { ResearchRecord } from "../../src/research/types";

const records: ResearchRecord[] = [
  { path: "Projects/P.md", title: "P", type: "research-project", project: "Projects/P.md", question: "Why?", stage: "reason", status: "active" },
  { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P.md", sourceKind: "pdf", contentFingerprint: "sha256:new" },
  { path: "Evidence/E1.md", title: "E1", type: "evidence", project: "Projects/P.md", source: "Sources/S.md", locatorKind: "page", locatorValue: "4", excerpt: "Result", reviewState: "reviewed", sourceFingerprint: "sha256:new" },
  { path: "Claims/C.md", title: "C", type: "claim", project: "Projects/P.md", proposition: "Effect", confidence: "high", reviewState: "reviewed", supports: ["Evidence/E1.md"], challenges: [], contextualizes: [], limitations: [] },
];

describe("buildProjectSnapshot", () => {
  it("reconstructs typed relationships and trusted support", () => {
    const snapshot = buildProjectSnapshot("Projects/P.md", records, []);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.claims[0]?.supporting).toEqual(["Evidence/E1.md"]);
    expect(snapshot.claims[0]?.trustedSupportCount).toBe(1);
    expect(snapshot.health).toEqual({ claimCount: 1, trustedSupportCount: 1, supportedClaimCount: 1 });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not trust stale reviewed evidence but permits legacy missing fingerprints", () => {
    const stale = records.map((record) => record.type === "evidence" ? { ...record, sourceFingerprint: "sha256:old" } : record) as ResearchRecord[];
    expect(buildProjectSnapshot("Projects/P.md", stale, []).claims[0]?.trustedSupportCount).toBe(0);
    const legacy = records.map((record) => record.type === "evidence" ? { ...record, sourceFingerprint: undefined } : record) as ResearchRecord[];
    expect(buildProjectSnapshot("Projects/P.md", legacy, []).claims[0]?.trustedSupportCount).toBe(1);
    const unavailableCapture = records.map((record) => record.type === "research-source" ? { ...record, contentFingerprint: undefined } : record) as ResearchRecord[];
    expect(buildProjectSnapshot("Projects/P.md", unavailableCapture, []).claims[0]?.trustedSupportCount).toBe(0);
  });

  it("selects a canonical duplicate independent of input order and records an issue", () => {
    const duplicate = { ...records[1]!, title: "Duplicate" } as ResearchRecord;
    const forward = buildProjectSnapshot("Projects/P.md", [...records, duplicate], []);
    const reverse = buildProjectSnapshot("Projects/P.md", [duplicate, ...records].reverse(), []);
    const snapshot = forward;
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot).toEqual(reverse);
    expect(auditProject(snapshot)).toEqual(auditProject(reverse));
    expect(snapshot.issues).toContainEqual(expect.objectContaining({ path: "Sources/S.md", code: "invalid-value" }));
  });

  it("deduplicates and stably sorts every claim relation before counting support", () => {
    const duplicated = records.map((record) => record.type === "claim" ? {
      ...record,
      supports: ["Evidence/E1.md", "Evidence/E1.md"],
      challenges: ["Evidence/Z.md", "Evidence/A.md", "Evidence/Z.md"],
      contextualizes: ["Evidence/Z.md", "Evidence/Z.md"],
    } : record) as ResearchRecord[];
    const claim = buildProjectSnapshot("Projects/P.md", duplicated, []).claims[0]!;
    expect(claim.supporting).toEqual(["Evidence/E1.md"]);
    expect(claim.challenging).toEqual(["Evidence/A.md", "Evidence/Z.md"]);
    expect(claim.contextual).toEqual(["Evidence/Z.md"]);
    expect(claim.trustedSupportCount).toBe(1);
  });
});
