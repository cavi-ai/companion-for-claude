import { describe, expect, it } from "vitest";
import { buildProjectSnapshot } from "../../src/research/graph";
import { renderEvidenceOutline, renderSynthesisMatrix } from "../../src/research/outline";
import type { ResearchRecord } from "../../src/research/types";
import { parse as parseYaml } from "yaml";
import { parseResearchRecord } from "../../src/research/parse";
import { parseDraftSections } from "../../src/research/draftSections";

const records: ResearchRecord[] = [
  { path: "Research/P/Project.md", title: "Project P", type: "research-project", project: "Research/P/Project.md", question: "Why?", stage: "shape", status: "active" },
  { path: "Research/P/Sources/S.md", title: "Source S", type: "research-source", project: "Research/P/Project.md", sourceKind: "pdf", contentFingerprint: "sha256:source" },
  { path: "Research/P/Evidence/Support.md", title: "Support", type: "evidence", project: "Research/P/Project.md", source: "Research/P/Sources/S.md", sourceFingerprint: "sha256:source", locatorKind: "page", locatorValue: "0014", excerpt: "Supporting excerpt.", reviewState: "reviewed" },
  { path: "Research/P/Evidence/Challenge.md", title: "Challenge", type: "evidence", project: "Research/P/Project.md", source: "Research/P/Sources/S.md", locatorKind: "section", locatorValue: "Limits", excerpt: "Challenging excerpt.", reviewState: "proposed" },
  { path: "Research/P/Evidence/Context.md", title: "Context", type: "evidence", project: "Research/P/Project.md", source: "Research/P/Sources/S.md", sourceFingerprint: "sha256:old", locatorKind: "paragraph", locatorValue: "3", excerpt: "Contextual excerpt.", reviewState: "reviewed" },
  { path: "Research/P/Claims/C.md", title: "Claim C", type: "claim", project: "Research/P/Project.md", proposition: "The result holds.", confidence: "moderate", reviewState: "reviewed", supports: ["Research/P/Evidence/Support.md"], challenges: ["Research/P/Evidence/Challenge.md"], contextualizes: ["Research/P/Evidence/Context.md"], limitations: ["Small sample"] },
];
const snapshot = buildProjectSnapshot("Research/P/Project.md", records, []);

describe("research outline renderers", () => {
  it("preserves all three native relations and exact evidence provenance", () => {
    const markdown = renderEvidenceOutline(snapshot, ["Research/P/Claims/C.md"]);
    expect(markdown).toContain("project: \"[[Research/P/Project.md]]\"");
    expect(markdown).toContain("## Claim C");
    for (const heading of ["### Supporting evidence", "### Challenging evidence", "### Contextual evidence"]) expect(markdown).toContain(heading);
    expect(markdown).toContain("Source: [[Research/P/Sources/S.md]]");
    expect(markdown).toContain("Locator: page 0014");
    expect(markdown).toContain("Source fingerprint: `sha256:source`");
    expect(markdown).toContain("> Supporting excerpt.");
    const managed = parseDraftSections(markdown);
    expect(managed.issues).toEqual([]);
    expect(managed.sections).toHaveLength(1);
    expect(managed.sections[0]?.envelope).toMatchObject({
      claimPaths: ["Research/P/Claims/C.md"],
      provider: "companion",
      model: "evidence-outline-v1",
    });
  });

  it("rejects claims and evidence references outside the snapshot", () => {
    expect(() => renderEvidenceOutline(snapshot, ["Other/Claim.md"])).toThrow("Claim is not part of project");
    const broken = buildProjectSnapshot("Research/P/Project.md", records.map((record) => record.type === "claim" ? { ...record, supports: ["Other/E.md"] } : record), []);
    expect(() => renderEvidenceOutline(broken, ["Research/P/Claims/C.md"])).toThrow("Evidence is not part of project");
  });

  it.each(["proposed", "rejected"] as const)("rejects %s claims without leaking proposition or evidence", (reviewState) => {
    const unsafe = buildProjectSnapshot("Research/P/Project.md", records.map((record) => record.type === "claim" ? { ...record, reviewState } : record), []);
    expect(() => renderEvidenceOutline(unsafe, ["Research/P/Claims/C.md"])).toThrow(new RegExp(`${reviewState} claim`, "i"));
  });

  it("renders a compact synthesis matrix without collapsing relations", () => {
    const matrix = renderSynthesisMatrix(snapshot);
    expect(matrix).toContain("| Claim | Supports | Challenges | Contextualizes |");
    expect(matrix).toContain("[[Research/P/Evidence/Support.md\\|Support]]");
    expect(matrix).toContain("[[Research/P/Evidence/Challenge.md\\|Challenge]]");
    expect(matrix).toContain("[[Research/P/Evidence/Context.md\\|Context]]");
    expect(matrix).toContain("reviewed; trusted");
    expect(matrix).toContain("proposed; untrusted");
    expect(matrix).toContain("reviewed; stale; untrusted");
    expect(matrix).toContain("Source S");
    expect(matrix).toContain("page 0014");
    expect(matrix).toContain("sha256:source");
  });

  it("serializes special-character frontmatter through the canonical serializer and round-trips", () => {
    const special = buildProjectSnapshot("Research/P/Project.md", records.map((record) => record.type === "research-project" ? { ...record, title: 'P: "quoted" # study' } : record), []);
    const markdown = renderEvidenceOutline(special, ["Research/P/Claims/C.md"]);
    const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) throw new Error("missing frontmatter");
    const parsed = parseResearchRecord({ path: "Research/P/Documents/Outline.md", frontmatter: parseYaml(match[1] ?? ""), body: match[2] ?? "" });
    expect(parsed.issues).toEqual([]);
    expect(parsed.record?.title).toBe('P: "quoted" # study — Evidence-backed outline');
  });
});
