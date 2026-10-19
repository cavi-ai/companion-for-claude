import { describe, expect, it, vi } from "vitest";
import { FakeElement } from "obsidian";
import { ResearchDraftPanel } from "../../src/view/ResearchDraftPanel";
import { buildProjectSnapshot } from "../../src/research/graph";
import { buildDraftGrounding, groundingClaimFingerprint } from "../../src/research/draftGrounding";
import { parseDraftSections, renderManagedDocument } from "../../src/research/draftSections";
import type { ResearchDocumentRecord, ResearchRecord } from "../../src/research/types";
import type { DraftCoordinator } from "../../src/research/draftCoordinator";
import type { RevisionCoordinator } from "../../src/research/revisionCoordinator";
import type { RevisionRequest } from "../../src/research/revisionPolicy";
import type { ResearchRepository } from "../../src/research/repository";

const project = "R/Project.md";
const records: ResearchRecord[] = [
  { path: project, title: "R", type: "research-project", project, question: "Why?", stage: "write", status: "active" },
  { path: "R/Sources/S.md", title: "S", type: "research-source", project, sourceKind: "web" },
  { path: "R/Evidence/E.md", title: "E", type: "evidence", project, source: "R/Sources/S.md", locatorKind: "page", locatorValue: "1", excerpt: "Results vary.", reviewState: "reviewed" },
  { path: "R/Claims/C.md", title: "C", type: "claim", project, proposition: "Results vary.", confidence: "moderate", reviewState: "reviewed", supports: ["R/Evidence/E.md"], challenges: [], contextualizes: [], limitations: [] },
];
const snapshot = buildProjectSnapshot(project, records, []);
const packet = buildDraftGrounding(snapshot, "R/Claims/C.md");
const document: ResearchDocumentRecord = { path: "R/Documents/Outline.md", title: "Outline", type: "research-document", project, documentKind: "outline", claims: [packet.claim.path] };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe.each(["draft", "revision"] as const)("pending section %s", (kind) => {
  it("shows cancellable progress, ignores duplicate starts, and permits retry without losing the revision instruction", async () => {
    const parsed = parseDraftSections(renderManagedDocument("", [{ heading: "C", markdown: "Results vary.", envelope: { id: "c", claimPaths: [packet.claim.path], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [], provider: kind === "draft" ? "companion" : "anthropic", model: kind === "draft" ? "evidence-outline-v1" : "model", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) } }]));
    let signal!: AbortSignal;
    let finish!: () => void;
    const preview = vi.fn((...args: unknown[]) => {
      signal = args.at(-1) as AbortSignal;
      return new Promise<never>((_resolve, reject) => { finish = () => reject(new Error("cancelled")); });
    });
    const root = new FakeElement() as unknown as HTMLElement;
    const render = () => { root.empty(); panel.render(root, snapshot, document, parsed); };
    const panel = new ResearchDraftPanel({ coordinator: { preview } as unknown as DraftCoordinator, revisionCoordinator: { preview } as unknown as RevisionCoordinator, repository: { loadProject: async () => snapshot } as unknown as ResearchRepository, rerender: render });
    const button = (text: string) => [...root.querySelectorAll("button")].find((el) => el.textContent === text)!;
    const click = (el: HTMLElement) => el.dispatchEvent({ type: "click" } as never);
    render();
    if (kind === "revision") {
      click(button("Revise section"));
      const input = root.querySelector("textarea") as HTMLTextAreaElement;
      input.value = "Keep the scope explicit.";
      input.dispatchEvent({ type: "input" } as never);
    }
    const startText = kind === "draft" ? "Preview draft" : "Preview revision";
    const start = button(startText);
    click(start);
    click(start);
    await flush();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    expect(root.querySelector(".cc-draft-status")?.textContent).toBe(kind === "draft" ? "Drafting section…" : "Preparing revision…");
    click(button(kind === "draft" ? "Cancel draft" : "Cancel revision"));
    expect(signal.aborted).toBe(true);
    finish();
    await flush();
    expect(root.querySelectorAll(".cc-draft-preview")).toHaveLength(0);
    if (kind === "revision") expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Keep the scope explicit.");
    click(button(startText));
    await flush();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    panel.dispose();
    finish();
    await flush();
  });
});

it("makes a blocked revision visible and expands its reasons without offering acceptance", async () => {
  const parsed = parseDraftSections(renderManagedDocument("", [{ heading: "C", markdown: "Results vary.", envelope: { id: "c", claimPaths: [packet.claim.path], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [], provider: "anthropic", model: "model", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) } }]));
  const section = parsed.sections[0]!;
  const revision = { section, packet, request: { intent: "clarity" }, envelope: section.envelope, response: { markdown: "New factual wording.", support: [], claimPreservation: [], changes: [], gaps: [], warnings: [], violations: ["Protected wording changed"], canAccept: false } };
  const root = new FakeElement() as unknown as HTMLElement;
  const render = () => { root.empty(); panel.render(root, snapshot, document, parsed); };
  const panel = new ResearchDraftPanel({ coordinator: {} as DraftCoordinator, revisionCoordinator: { preview: async () => revision } as unknown as RevisionCoordinator, repository: { loadProject: async () => snapshot } as unknown as ResearchRepository, rerender: render });
  const button = (text: string) => [...root.querySelectorAll("button")].find((el) => el.textContent === text)!;
  render();
  button("Revise section").dispatchEvent({ type: "click" } as never);
  button("Preview revision").dispatchEvent({ type: "click" } as never);
  await flush();
  expect(root.querySelector('[role="alert"]')?.textContent).toBe("This revision cannot be accepted. Review the issues below, then discard it and try again.");
  expect(root.querySelector(".cc-revision-report")?.getAttribute("open")).toBe("");
  expect(button("Accept revision")).toBeUndefined();
});

it.each([false, true])("preserves instructions when discarding a revision with canAccept=%s", async (canAccept) => {
  const parsed = parseDraftSections(renderManagedDocument("", [{ heading: "C", markdown: "Results vary.", envelope: { id: "c", claimPaths: [packet.claim.path], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [], provider: "anthropic", model: "model", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) } }]));
  const section = parsed.sections[0]!;
  const preview = vi.fn(async (_snapshot: unknown, _section: unknown, request: RevisionRequest) => ({ section, packet, request, envelope: section.envelope, response: { markdown: "Results vary!", support: [], claimPreservation: [], changes: [], gaps: [], warnings: [], violations: canAccept ? [] : ["Protected wording changed"], canAccept } }));
  const root = new FakeElement() as unknown as HTMLElement;
  const render = () => { root.empty(); panel.render(root, snapshot, document, parsed); };
  const panel = new ResearchDraftPanel({ coordinator: {} as DraftCoordinator, revisionCoordinator: { preview } as unknown as RevisionCoordinator, repository: { loadProject: async () => snapshot } as unknown as ResearchRepository, rerender: render });
  const button = (text: string) => [...root.querySelectorAll("button")].find((el) => el.textContent === text)!;
  const click = (text: string) => button(text).dispatchEvent({ type: "click" } as never);
  const type = (text: string) => { const input = root.querySelector("textarea") as HTMLTextAreaElement; input.value = text; input.dispatchEvent({ type: "input" } as never); };
  render();
  click("Revise section");
  const intent = root.querySelector("select") as HTMLSelectElement;
  intent.value = "custom";
  intent.dispatchEvent({ type: "change" } as never);
  type("  Keep the limitations explicit.  ");
  click("Preview revision");
  await flush();
  click("Discard revision");
  expect(root.querySelectorAll(".cc-draft-preview")).toHaveLength(0);
  expect((root.querySelector("textarea") as HTMLTextAreaElement)?.value).toBe("  Keep the limitations explicit.  ");
  expect((root.querySelector("select") as HTMLSelectElement)?.value).toBe("custom");
  expect(preview).toHaveBeenCalledTimes(1);
  type("Improve punctuation without adding facts.");
  click("Preview revision");
  await flush();
  expect(preview).toHaveBeenCalledTimes(2);
  expect(preview.mock.calls[1]?.[2]).toEqual({ intent: "custom", customInstruction: "Improve punctuation without adding facts." });
  click("Discard revision");
  click("Cancel revision");
  click("Revise section");
  expect((root.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect((root.querySelector("select") as HTMLSelectElement).value).toBe("clarity");
});

it.each(["draft", "revision"] as const)("keeps an unchanged %s preview actionable", async (kind) => {
  const parsed = parseDraftSections(renderManagedDocument("", [{ heading: "C", markdown: "Results vary.", envelope: { id: "c", claimPaths: [packet.claim.path], evidence: packet.evidence.map(({ path, fingerprint }) => ({ path, fingerprint })), citations: [], provider: kind === "draft" ? "companion" : "anthropic", model: kind === "draft" ? "evidence-outline-v1" : "model", generatedAt: "then", claimFingerprint: groundingClaimFingerprint(packet) } }]));
  const section = parsed.sections[0]!;
  const preview = async () => ({ section, packet, request: { intent: "clarity" }, envelope: section.envelope, response: { markdown: section.markdown, support: [], claimPreservation: [], changes: [], gaps: [], warnings: [], violations: [], canAccept: true } });
  const root = new FakeElement() as unknown as HTMLElement;
  const render = () => { root.empty(); panel.render(root, snapshot, document, parsed); };
  const panel = new ResearchDraftPanel({ coordinator: { preview } as unknown as DraftCoordinator, revisionCoordinator: { preview } as unknown as RevisionCoordinator, repository: { loadProject: async () => snapshot } as unknown as ResearchRepository, rerender: render });
  const button = (text: string) => [...root.querySelectorAll("button")].find((el) => el.textContent === text)!;
  render();
  if (kind === "draft") await expect(panel.preview(snapshot, section)).resolves.toBeUndefined();
  else {
    button("Revise section").dispatchEvent({ type: "click" } as never);
    button("Preview revision").dispatchEvent({ type: "click" } as never);
    await flush();
  }
  expect(root.querySelector(".cc-draft-unchanged")?.textContent).toBe("No text changes suggested.");
  expect(button(kind === "draft" ? "Accept section" : "Accept revision")).toBeDefined();
  const discard = button(kind === "draft" ? "Discard preview" : "Discard revision");
  expect(discard).toBeDefined();
  discard.dispatchEvent({ type: "click" } as never);
  expect(root.querySelectorAll(".cc-draft-preview")).toHaveLength(0);
});
