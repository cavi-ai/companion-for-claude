import { describe, expect, it, vi } from "vitest";
import { FakeElement } from "obsidian";
import { ResearchDraftPanel } from "../../src/view/ResearchDraftPanel";
import { buildProjectSnapshot, type ProjectSnapshot } from "../../src/research/graph";
import { buildDraftGrounding, groundingClaimFingerprint } from "../../src/research/draftGrounding";
import { parseDraftSections, renderManagedDocument, type ParsedDraftSection } from "../../src/research/draftSections";
import type { ResearchDocumentRecord, ResearchRecord } from "../../src/research/types";
import type { DraftCoordinator, DraftPreview } from "../../src/research/draftCoordinator";
import type { RevisionCoordinator } from "../../src/research/revisionCoordinator";
import type { RevisionRequest } from "../../src/research/revisionPolicy";
import type { ResearchRepository } from "../../src/research/repository";

function scope(name: string) {
  const project = `${name}/Project.md`;
  const source = `${name}/Sources/S.md`;
  const evidence = `${name}/Evidence/E.md`;
  const claim = `${name}/Claims/C.md`;
  const records: ResearchRecord[] = [
    { path: project, title: name, type: "research-project", project, question: "Why?", stage: "write", status: "active" },
    { path: source, title: "S", type: "research-source", project, sourceKind: "zotero", zoteroKey: `${name.toLowerCase()}-study`, contentFingerprint: "current" },
    { path: evidence, title: "E", type: "evidence", project, source, sourceFingerprint: "current", locatorKind: "page", locatorValue: "1", excerpt: "Results vary.", reviewState: "reviewed" },
    { path: claim, title: "C", type: "claim", project, proposition: "Results vary.", confidence: "moderate", reviewState: "reviewed", supports: [evidence], challenges: [], contextualizes: [], limitations: [] },
  ];
  const snapshot = buildProjectSnapshot(project, records, []);
  const packet = buildDraftGrounding(snapshot, claim);
  const document: ResearchDocumentRecord = { path: `${name}/Documents/Outline.md`, title: "Outline", type: "research-document", project, documentKind: "outline", claims: [claim] };
  const parsed = (accepted: boolean) => parseDraftSections(renderManagedDocument("", [{ heading: "C", markdown: "Results vary.", envelope: { id: "same-id", claimPaths: [claim], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [], provider: accepted ? "anthropic" : "companion", model: accepted ? "model" : "evidence-outline-v1", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) } }]));
  return { snapshot, document, parsed };
}
const first = scope("R");
const second = scope("S");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup(accept = async () => undefined) {
  let current = first;
  let accepted = false;
  const root = new FakeElement() as unknown as HTMLElement;
  const render = () => { root.empty(); panel.render(root, current.snapshot, current.document, current.parsed(accepted)); };
  const preview = vi.fn(async (snapshot: ProjectSnapshot, section: ParsedDraftSection): Promise<DraftPreview> => {
    const packet = buildDraftGrounding(snapshot, snapshot.claims[0]!.path);
    const markdown = `Results vary. [@${packet.evidence[0]!.citationKey}]`;
    return { section, packet, response: { markdown, support: [{ passage: markdown, claimPath: packet.claim.path, evidencePaths: [packet.evidence[0]!.path], citationKeys: [packet.evidence[0]!.citationKey] }], gaps: [] }, envelope: { ...section.envelope, provider: "anthropic", model: `model-${snapshot.project.title}` } };
  });
  const revision = async (snapshot: ProjectSnapshot, section: ParsedDraftSection, request: RevisionRequest) => {
    const result = await preview(snapshot, section);
    return { ...result, request, response: { ...result.response, claimPreservation: [{ claimPath: result.packet.claim.path, passage: result.response.markdown, status: "preserved" }], changes: [], warnings: [], violations: [], canAccept: true } };
  };
  const panel = new ResearchDraftPanel({ coordinator: { preview } as unknown as DraftCoordinator, revisionCoordinator: { preview: revision } as unknown as RevisionCoordinator, repository: { loadProject: async (path: string) => path === first.snapshot.project.path ? first.snapshot : second.snapshot, acceptDraftSection: accept, acceptRevisionSection: accept } as unknown as ResearchRepository, rerender: render });
  const show = (next = first, isAccepted = false) => { current = next; accepted = isAccepted; render(); };
  const button = (text: string) => [...root.querySelectorAll("button")].find((el) => el.textContent === text)!;
  const click = (text: string) => button(text).dispatchEvent({ type: "click" } as never);
  const type = (text: string) => { const input = root.querySelector("textarea") as HTMLTextAreaElement; input.value = text; input.dispatchEvent({ type: "input" } as never); };
  return { root, panel, preview, show, click, type };
}

describe("section work ownership", () => {
  it("retains custom revision forms separately for each project and document", () => {
    const { root, show, click, type } = setup();
    show(first, true);
    click("Revise section");
    const intent = root.querySelector("select") as HTMLSelectElement;
    intent.value = "custom";
    intent.dispatchEvent({ type: "change" } as never);
    type("Revision for R");
    show(second, true);
    click("Revise section");
    type("Revision for S");
    show(first, true);
    expect((root.querySelector("textarea") as HTMLTextAreaElement)?.value).toBe("Revision for R");
    expect((root.querySelector("select") as HTMLSelectElement)?.value).toBe("custom");
    show({ ...first, document: { ...first.document, path: "R/Documents/Other.md" } }, true);
    click("Revise section");
    expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    type("Another document");
    show(second, true);
    expect((root.querySelector("textarea") as HTMLTextAreaElement)?.value).toBe("Revision for S");
    show(first, true);
    expect((root.querySelector("textarea") as HTMLTextAreaElement)?.value).toBe("Revision for R");
  });

  it("restores completed previews without generating again and discards only the selected scope", async () => {
    const { root, panel, preview, show, click } = setup();
    show(first);
    await panel.preview(first.snapshot, first.parsed(false).sections[0]!);
    show(second);
    await panel.preview(second.snapshot, second.parsed(false).sections[0]!);
    show(first);
    expect(root.querySelector(".cc-draft-provider")?.textContent).toBe("anthropic · model-R");
    await panel.preview(first.snapshot, first.parsed(false).sections[0]!);
    expect(preview).toHaveBeenCalledTimes(2);
    click("Discard preview");
    show(second);
    expect(root.querySelector(".cc-draft-provider")?.textContent).toBe("anthropic · model-S");
  });

  it.each(["draft", "revision"] as const)("finishing a %s acceptance cannot delete another project's preview with the same section id", async (kind) => {
    let finish!: () => void;
    const { root, panel, show, click } = setup(() => new Promise<void>((resolve) => { finish = resolve; }));
    const prepare = async (current: typeof first) => {
      show(current, kind === "revision");
      if (kind === "draft") await panel.preview(current.snapshot, current.parsed(false).sections[0]!);
      else { click("Revise section"); click("Preview revision"); await flush(); }
    };
    await prepare(first);
    click(kind === "draft" ? "Accept section" : "Accept revision");
    await flush();
    await prepare(second);
    finish();
    await flush();
    expect(root.querySelectorAll(".cc-draft-preview")).toHaveLength(1);
    expect(root.querySelector(".cc-draft-provider")?.textContent).toContain("model-S");
    show(first, kind === "revision");
    expect(root.querySelectorAll(".cc-draft-preview")).toHaveLength(0);
    show(second, kind === "revision");
    expect(root.querySelectorAll(".cc-draft-preview")).toHaveLength(1);
  });
});
