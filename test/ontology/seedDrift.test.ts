import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { conform } from "../../src/ontology/conform";
import { PLUGIN_NOTE_TYPES } from "../../src/ontology/pluginTypes";
import { resolveTypes } from "../../src/ontology/schema";
import { planSeed, schemaNoteContent, SEED_TYPES, seedFiles } from "../../src/ontology/seed";
import { renderResearchRecord } from "../../src/research/render";
import { renderMemoryNote } from "../../src/memory/consolidate";
import { renderDistilledNote } from "../../src/conversations/distill";
import { renderOrderRun } from "../../src/orders/output";
import { renderRunNote } from "../../src/optimize/mergePlan";
import { renderLinkRunNote } from "../../src/optimize/linkPlan";
import { renderTypeRunNote } from "../../src/optimize/typeController";
import { renderTriageNote } from "../../src/research/triage";
import { projectNoteBody } from "../../src/projects/model";
import { sourceFrontmatter } from "../../src/sources/sourceNote";
import type { ResearchRecord } from "../../src/research/types";
import type { SourceRecord } from "../../src/sources/types";

const { resolved, errors } = resolveTypes(SEED_TYPES);

function frontmatterOf(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) throw new Error("note has no frontmatter");
  return parse(match[1] ?? "") as Record<string, unknown>;
}

function issues(frontmatter: Record<string, unknown>): string[] {
  const type = String(frontmatter.type);
  return conform(frontmatter, resolved.get(type), () => undefined).issues.map((i) => `${type}: ${i.message}`);
}

const research: ResearchRecord[] = [
  { path: "Projects/P.md", title: "P", type: "research-project", project: "Projects/P", question: "What works?", audience: "Researchers", stage: "gather", status: "active" },
  { path: "Sources/S.md", title: "S", type: "research-source", project: "Projects/P", sourceKind: "doi", canonicalId: "10.1/x", url: "https://example.test", asset: "Files/S.pdf", contentFingerprint: "sha256:abc", doi: "10.1/x", arxivId: "2501.01234", zoteroKey: "KEY1", authors: ["Ada Lovelace"], published: "2025-04-02", publication: "Journal of Tests", abstract: "Abstract text", openAccessUrl: "https://example.test/open.pdf", discoveryProvenance: [{ adapter: "openalex", externalId: "W1" }] },
  { path: "Evidence/E.md", title: "E", type: "evidence", project: "Projects/P", source: "Sources/S", sourceFingerprint: "sha256:abc", locatorKind: "page", locatorValue: "14", excerpt: "Measured effect.", interpretation: "Useful result.", reviewState: "reviewed", model: "claude" },
  { path: "Claims/C.md", title: "C", type: "claim", project: "Projects/P", proposition: "The effect generalizes.", confidence: "moderate", reviewState: "proposed", supports: ["Evidence/E1"], challenges: [], contextualizes: [], limitations: ["Small sample"] },
  { path: "Questions/Q.md", title: "Q", type: "research-question", project: "Projects/P", question: "Does it generalize?", status: "open", about: "Claims/C" },
  { path: "Documents/D.md", title: "D", type: "research-document", project: "Projects/P", documentKind: "outline", claims: ["Claims/C"] },
];

const source = (type: SourceRecord["type"], fields: SourceRecord["fields"]): SourceRecord => ({
  type,
  fields,
  provenance: { url: "https://example.test", capturedAt: "2026-10-07", schemaVersion: 1, enrichedBy: "claude" },
});

/** Every renderer that writes a typed note, with the note it writes. */
const written: Array<[string, () => Record<string, unknown>]> = [
  ...research.map((r): [string, () => Record<string, unknown>] => [r.type, () => frontmatterOf(renderResearchRecord(r))]),
  ["claude-memory", () => frontmatterOf(renderMemoryNote("- a fact", { updated: "2026-10-07", digestCount: 2, baseTags: ["claude"] }))],
  ["chat-summary", () => frontmatterOf(renderDistilledNote({ title: "T", summary: "S", decisions: [], facts: [], openItems: [] }, { conversationId: "c1", created: "2026-10-07", notes: [], tags: ["claude"] }))],
  ["order-run", () => frontmatterOf(renderOrderRun({ path: "Templates/O.md" } as never, { kind: "note", path: "Inbox/N.md" } as never, { text: "done", proposals: [] } as never))],
  ["optimize-run (tags)", () => frontmatterOf(renderRunNote({ applied: [], failed: [], orders: [] }, "2026-10-07"))],
  ["optimize-run (links)", () => frontmatterOf(renderLinkRunNote({ applied: [], conflicts: [], failed: [] }, "2026-10-07"))],
  ["optimize-run (types)", () => frontmatterOf(renderTypeRunNote({ applied: [], skipped: [], failed: [] }, "2026-10-07"))],
  ["triage", () => frontmatterOf(renderTriageNote([], new Map(), "2026-10-07T12:00:00Z"))],
  ["chat-project", () => ({ ...frontmatterOf(projectNoteBody("Work")), pinned: ["[[Brief]]"] })],
  ["article", () => sourceFrontmatter(source("article", { title: "A", site: "Example", summary: "S", topics: ["x"] }), ["clip"]) as Record<string, unknown>],
  ["video", () => sourceFrontmatter(source("video", { title: "V", channel: "C", summary: "S" }), ["clip"]) as Record<string, unknown>],
  ["dataset", () => sourceFrontmatter(source("dataset", { title: "D", summary: "S" }), ["clip"]) as Record<string, unknown>],
];

describe("seeded ontology matches what the plugin writes", () => {
  it("resolves without errors and seeds every plugin type", () => {
    expect(errors).toEqual([]);
    for (const type of PLUGIN_NOTE_TYPES) expect(resolved.has(type), type).toBe(true);
  });

  it.each(written)("%s conforms with no issues", (_label, render) => {
    expect(issues(render())).toEqual([]);
  });
});

describe("planSeed", () => {
  const files = seedFiles();
  const v2 = (name: string) => files.find((f) => f.fileName === `${name}.md`)!.content;

  it("creates every missing schema note", () => {
    expect(planSeed(() => null).map((w) => [w.fileName, w.upgrade])).toEqual(files.map((f) => [f.fileName, false]));
  });

  it("upgrades an unedited version 1 research schema and leaves edited or current ones alone", () => {
    const v1Claim = schemaNoteContent({
      name: "claim", version: 1, extendsType: "entity",
      properties: [
        { key: "proposition", type: "string", required: true },
        { key: "confidence", type: "string", required: true },
        { key: "reviewState", type: "string", required: true },
        { key: "limitations", type: "string[]", required: true },
      ],
      relations: [
        { key: "supports", targets: ["evidence"], description: "evidence supporting this claim" },
        { key: "challenges", targets: ["evidence"], description: "evidence challenging this claim" },
        { key: "contextualizes", targets: ["evidence"], description: "evidence providing context for this claim" },
        { key: "project", targets: ["research-project"], description: "owning research project" },
      ],
    });
    const current = (fileName: string): string | null =>
      fileName === "claim.md" ? v1Claim : fileName === "evidence.md" ? `${v2("evidence")}edited` : files.find((f) => f.fileName === fileName)!.content;
    expect(planSeed(current)).toEqual([{ fileName: "claim.md", content: v2("claim"), upgrade: true }]);
  });
});
