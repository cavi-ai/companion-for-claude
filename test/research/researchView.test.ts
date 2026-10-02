import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { FakeElement } from "../fakes/obsidian";
import { buildProjectSnapshot } from "../../src/research/graph";
import { parseDraftSections, renderManagedDocument } from "../../src/research/draftSections";
import { ResearchView, ResearchWorkbenchRedirect, RESEARCH_DESK_VIEW_TYPE } from "../../src/view/ResearchView";
import type { ResearchRecord } from "../../src/research/types";

const P = "Research/A/Project.md";
const project = { path: P, title: "Audio", type: "research-project", project: P, question: "How?", stage: "frame", status: "active" } as const;
const records: ResearchRecord[] = [
  project,
  { path: "Research/A/Sources/S.md", title: "Source", type: "research-source", project: P, sourceKind: "web" },
  { path: "Research/A/Evidence/E1.md", title: "E1", type: "evidence", project: P, source: "Research/A/Sources/S.md", locatorKind: "page", locatorValue: "1", excerpt: "a", reviewState: "reviewed" },
  { path: "Research/A/Evidence/E2.md", title: "E2", type: "evidence", project: P, source: "Research/A/Sources/S.md", locatorKind: "page", locatorValue: "2", excerpt: "b", reviewState: "reviewed" },
  { path: "Research/A/Claims/C.md", title: "Codecs dominate", type: "claim", project: P, proposition: "Codecs dominate.", confidence: "high", reviewState: "reviewed", supports: ["Research/A/Evidence/E1.md", "Research/A/Evidence/E2.md"], challenges: [], contextualizes: [], limitations: [] },
  { path: "Research/A/Documents/Outline.md", title: "Outline", type: "research-document", project: P, documentKind: "outline", claims: ["Research/A/Claims/C.md"] },
];
const snapshot = buildProjectSnapshot(P, records, []);
const outlineDoc = renderManagedDocument("# Outline", [{ envelope: { id: "c", claimPaths: ["Research/A/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }, heading: "Codecs dominate", markdown: "Codecs dominate." }]);

function make(over: { snapshot?: typeof snapshot; doc?: string; projects?: Array<typeof project> } = {}) {
  const repository = {
    listProjects: vi.fn(async () => over.projects ?? [project]),
    loadProject: vi.fn(async () => over.snapshot ?? snapshot),
    loadDraftSections: vi.fn(async () => parseDraftSections(over.doc ?? outlineDoc)),
    convertDocumentFormat: vi.fn(async () => 1),
  };
  const actions = { createProject: vi.fn(), addSource: vi.fn(), extractEvidence: vi.fn(), createClaim: vi.fn(), reviewClaim: vi.fn(), runStep: vi.fn(async () => undefined) };
  const askResearch = vi.fn(async (..._args: unknown[]) => true);
  const openPath = vi.fn(async () => undefined);
  const draftCoordinator = { preview: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => { throw new Error("stop"); }) };
  const view = new ResearchView(new WorkspaceLeaf(), repository as never, { actions: actions as never, askResearch, openPath, webSearchEnabled: () => false, draftCoordinator: draftCoordinator as never });
  return { view, repository, actions, askResearch, openPath, draftCoordinator };
}
const all = (view: ResearchView, selector: string) => view.contentEl.querySelectorAll(selector) as unknown as HTMLElement[];
const button = (view: ResearchView, text: string) => all(view, "button").find(({ textContent }) => textContent === text);
const click = (element: HTMLElement | undefined) => { if (!element) throw new Error("missing element"); element.dispatchEvent({ type: "click" } as never); };
const childIndex = (view: ResearchView, cls: string) => (view.contentEl.children as unknown as Array<{ classList: Set<string> }>).findIndex((child) => child.classList.has(cls));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ResearchView", () => {
  it("registers under the desk id", () => {
    const { view } = make();
    expect(view.getViewType()).toBe(RESEARCH_DESK_VIEW_TYPE);
    expect(view.getDisplayText()).toBe("Research Desk");
  });

  it("renders header, ask, argument, document and sources, and nothing from the old desk", async () => {
    const { view } = make();
    await view.setProjectPath(P);
    expect(all(view, "h2")[0]?.textContent).toBe("Audio");
    for (const selector of [".cc-desk-ask", ".cc-desk-argument", ".cc-desk-document", ".cc-desk-sources"]) expect(all(view, selector)).toHaveLength(1);
    const indices = [".cc-desk-header", ".cc-desk-ask", ".cc-desk-argument", ".cc-desk-document", ".cc-desk-sources"].map((selector) => childIndex(view, selector.slice(1)));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    for (const selector of [".cc-desk-fix", ".cc-research-tabs", ".cc-desk-stage", ".cc-desk-next"]) expect(all(view, selector)).toHaveLength(0);
    expect(all(view, ".cc-desk-chip")[0]?.textContent).toBe("Not drafted");
    expect(all(view, ".cc-desk-document-progress")[0]?.textContent).toBe("0 of 1 section drafted");
    expect(all(view, ".cc-desk-counts")[0]?.textContent).toBe("1 source · 2 passages · 1 claim");
  });

  it("sends a chat step to Claude with the project prompt", async () => {
    const { view, askResearch } = make();
    await view.setProjectPath(P);
    click(button(view, 'Look for evidence against "Codecs dominate"'));
    await flush();
    expect(askResearch).toHaveBeenCalledWith(P, expect.stringContaining(`Research project: [[${P}]]`), 'Look for evidence against "Codecs dominate"');
  });

  it("sends a typed instruction", async () => {
    const { view, askResearch } = make();
    await view.setProjectPath(P);
    const input = all(view, "textarea")[0] as unknown as { value: string };
    input.value = "Summarize the codecs";
    click(button(view, "Send"));
    await flush();
    expect(askResearch).toHaveBeenCalledWith(P, expect.stringContaining("Task: Summarize the codecs"), "Summarize the codecs");
  });

  it("keeps the typed instruction when chat cannot take it and clears it once sent", async () => {
    const { view, askResearch } = make();
    await view.setProjectPath(P);
    const input = () => all(view, "textarea")[0] as unknown as { value: string };
    input().value = "Summarize the codecs";
    input().dispatchEvent({ type: "input" } as never);
    askResearch.mockResolvedValueOnce(false);
    click(button(view, "Send"));
    await flush();
    expect(input().value).toBe("Summarize the codecs");
    click(button(view, "Send"));
    await flush();
    expect(input().value).toBe("");
  });

  it("restores Ask focus and caret across a refresh", async () => {
    const { view } = make();
    await view.setProjectPath(P);
    const focus = vi.spyOn(FakeElement.prototype, "focus");
    const old = all(view, "textarea")[0] as unknown as FakeElement & { value: string };
    old.dispatchEvent({ type: "focus" });
    old.value = "Summarize";
    old.selectionStart = 3;
    old.selectionEnd = 6;
    old.dispatchEvent({ type: "input" });
    focus.mockClear();
    await view.render();
    const next = all(view, "textarea")[0] as unknown as FakeElement & { value: string };
    expect(next).not.toBe(old);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.contexts[0]).toBe(next);
    expect([next.value, next.selectionStart, next.selectionEnd]).toEqual(["Summarize", 3, 6]);
    focus.mockClear();
    next.dispatchEvent({ type: "blur" });
    await view.render();
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it("runs a draft step through the draft coordinator", async () => {
    const { view, draftCoordinator } = make();
    await view.setProjectPath(P);
    click(button(view, 'Draft "Codecs dominate"'));
    await flush();
    expect(draftCoordinator.preview).toHaveBeenCalledWith(snapshot, expect.objectContaining({ heading: "Codecs dominate" }), expect.anything());
  });

  it("offers clean-up on an old document", async () => {
    const meta = encodeURIComponent(JSON.stringify({ id: "c", claimPaths: ["Research/A/Claims/C.md"], evidence: [], citations: [], provider: "companion", model: "evidence-outline-v1", generatedAt: "outline" }));
    const v1 = `<!-- cavi:draft-section version=1 meta=${meta} fingerprint=fnv1a-0 -->\n## Codecs dominate\n\nX\n<!-- cavi:draft-section:end id=c -->\n`;
    const { view, repository } = make({ doc: v1 });
    await view.setProjectPath(P);
    click(button(view, "Clean up format"));
    await flush();
    expect(repository.convertDocumentFormat).toHaveBeenCalledWith("Research/A/Documents/Outline.md");
  });

  it("shows fix-first findings", async () => {
    const broken = buildProjectSnapshot(P, [...records.slice(0, 4), { ...(records[4] as object), supports: ["Research/A/Evidence/Gone.md"] } as ResearchRecord], []);
    const { view, openPath } = make({ snapshot: broken });
    await view.setProjectPath(P);
    expect(all(view, ".cc-desk-fix")).toHaveLength(1);
    expect(childIndex(view, "cc-desk-header")).toBeLessThan(childIndex(view, "cc-desk-fix"));
    expect(childIndex(view, "cc-desk-fix")).toBeLessThan(childIndex(view, "cc-desk-ask"));
    click(all(view, ".cc-desk-fix-row")[0]);
    await flush();
    expect(openPath).toHaveBeenCalledWith("Research/A/Claims/C.md");
  });

  it("expands a card to its passages", async () => {
    const { view } = make();
    await view.setProjectPath(P);
    click(all(view, ".cc-desk-card-head")[0]);
    await flush();
    expect(all(view, ".cc-desk-passage").map(({ textContent }) => textContent)).toEqual(["Supports: E1", "Supports: E2"]);
  });

  it("starts from nothing", async () => {
    const { view, actions } = make({ projects: [] });
    await view.setProjectPath(undefined);
    expect(all(view, "h2")[0]?.textContent).toBe("Start a research project");
    click(button(view, "New project"));
    expect(actions.createProject).toHaveBeenCalled();
  });

  it("project switch disposes the draft panel", async () => {
    const { view, draftCoordinator } = make();
    await view.setProjectPath(P);
    let signal: AbortSignal | undefined;
    draftCoordinator.preview.mockImplementationOnce(async (...args: unknown[]) => { signal = args[2] as AbortSignal; return new Promise(() => undefined); });
    click(button(view, 'Draft "Codecs dominate"'));
    await flush();
    await view.setProjectPath("Research/B/Project.md");
    expect(signal?.aborted).toBe(true);
  });
});

describe("ResearchWorkbenchRedirect", () => {
  it("turns an old workbench leaf into the desk", async () => {
    const leaf = new WorkspaceLeaf() as WorkspaceLeaf & { setViewState: ReturnType<typeof vi.fn> };
    leaf.setViewState = vi.fn(async () => undefined);
    await new ResearchWorkbenchRedirect(leaf).onOpen();
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: RESEARCH_DESK_VIEW_TYPE, active: true });
  });
});
