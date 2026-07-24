import { describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "obsidian";
import { buildProjectSnapshot } from "../../src/research/graph";
import { ResearchDeskView, RESEARCH_DESK_VIEW_TYPE } from "../../src/view/ResearchDeskView";
import type { ResearchRecord } from "../../src/research/types";

const project = { path: "Research/P/Project.md", title: "Continuity", type: "research-project", project: "Research/P/Project.md", question: "How does research retain continuity?", stage: "write", status: "active" } as const;
const records: ResearchRecord[] = [
  project,
  { path: "Research/P/Sources/S.md", title: "Study", type: "research-source", project: project.path, sourceKind: "web", contentFingerprint: "sha256:new" },
  { path: "Research/P/Evidence/E.md", title: "Continuity result", type: "evidence", project: project.path, source: "Research/P/Sources/S.md", sourceFingerprint: "sha256:old", locatorKind: "page", locatorValue: "4", excerpt: "Result", reviewState: "reviewed" },
  { path: "Research/P/Claims/C.md", title: "Continuity claim", type: "claim", project: project.path, proposition: "Continuity survives.", confidence: "moderate", reviewState: "reviewed", supports: ["Research/P/Evidence/E.md"], challenges: [], contextualizes: [], limitations: [] },
  { path: "Research/P/Questions/Q.md", title: "Mechanism", type: "research-question", project: project.path, question: "Which mechanism matters?", status: "open" },
  { path: "Research/P/Documents/Draft.md", title: "White paper", type: "research-document", project: project.path, documentKind: "draft", claims: ["Research/P/Claims/C.md"] },
];
const snapshot = buildProjectSnapshot(project.path, records, []);

function elements(view: ResearchDeskView, selector: string): HTMLElement[] { return view.contentEl.querySelectorAll(selector) as unknown as HTMLElement[]; }
function click(element: HTMLElement | undefined): void { if (!element) throw new Error("missing element"); element.dispatchEvent({ type: "click" }); }

describe("ResearchDeskView", () => {
  it("registers as the premium daily research entry point", () => {
    const view = new ResearchDeskView(new WorkspaceLeaf(), {} as never, {} as never);
    expect(view.getViewType()).toBe(RESEARCH_DESK_VIEW_TYPE);
    expect(view.getDisplayText()).toBe("Research Desk");
    expect(view.getIcon()).toBe("layout-dashboard");
  });

  it("renders an explainable first viewport and contextual workbench handoff", async () => {
    const openWorkbench = vi.fn(async () => undefined);
    const askCompanion = vi.fn(async () => undefined);
    const view = new ResearchDeskView(new WorkspaceLeaf(), {
      listProjects: async () => [project], loadProject: async () => snapshot,
      loadDraftSections: async () => ({ issues: [], sections: [{ envelope: { provider: "anthropic" }, modifiedSinceReview: false }, { envelope: { provider: "companion" }, modifiedSinceReview: false }] }),
    } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench, askCompanion });
    await view.setProjectPath(project.path);
    expect(elements(view, "h2")[0]?.textContent).toBe("Continuity");
    expect(elements(view, ".cc-desk-next")).toHaveLength(1);
    expect(elements(view, ".cc-desk-next-reason")[0]?.textContent).toMatch(/changed after this evidence was reviewed/i);
    expect(elements(view, ".cc-desk-stage-step")).toHaveLength(7);
    expect(elements(view, ".is-current")).toHaveLength(1);
    expect(elements(view, ".cc-desk-document-progress")[0]?.getAttribute("aria-valuenow")).toBe("50");
    expect(elements(view, ".cc-desk-attention-row").length).toBeGreaterThan(0);
    expect(elements(view, ".cc-desk-header-actions")).toHaveLength(1);
    expect(elements(view, "select")).toHaveLength(1);
    expect(elements(view, "button").map(({ textContent }) => textContent)).toContain("Ask Companion");
    click(elements(view, "button").find(({ textContent }) => textContent === "Start this task"));
    await Promise.resolve();
    expect(openWorkbench).toHaveBeenCalledWith(project.path, "Evidence", "Research/P/Evidence/E.md");
    click(elements(view, "button").find(({ textContent }) => textContent === "Ask Companion"));
    await Promise.resolve();
    expect(askCompanion).toHaveBeenCalledWith(project.path);
  });

  it("supports project switching plus dismiss and pin controls without implicit work", async () => {
    const other = { ...project, path: "Research/Other/Project.md", project: "Research/Other/Project.md", title: "Other" };
    let preferences = { dismissedActionIds: [] as string[], pinnedActionId: undefined as string | undefined };
    const updatePreferences = vi.fn(async (_path, update) => { preferences = update(preferences); });
    const loadProject = vi.fn(async (path: string) => path === project.path ? snapshot : buildProjectSnapshot(other.path, [other], []));
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [project, other], loadProject } as never, { preferencesFor: () => preferences, updatePreferences, openWorkbench: vi.fn() });
    await view.setProjectPath(project.path);
    click(elements(view, "button").find(({ textContent }) => textContent === "Dismiss")); await Promise.resolve(); await Promise.resolve();
    expect(updatePreferences).toHaveBeenCalled();
    click(elements(view, "button").find(({ textContent }) => textContent === "Pin")); await Promise.resolve(); await Promise.resolve();
    expect(elements(view, ".cc-desk-next")[0]?.getAttribute("data-pinned")).toBe("true");
    const select = elements(view, "select")[0] as HTMLSelectElement; select.value = other.path; select.dispatchEvent({ type: "change" }); await Promise.resolve(); await Promise.resolve();
    expect(loadProject).toHaveBeenCalledWith(other.path);
    expect(view.getProjectPath()).toBe(other.path);
  });

  it("opens the first deterministic project instead of showing an empty desk", async () => {
    const other = { ...project, path: "Research/Other/Project.md", project: "Research/Other/Project.md", title: "Other" };
    const loadProject = vi.fn(async () => snapshot);
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [project, other], loadProject } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn() });
    await view.render();
    expect(view.getProjectPath()).toBe(project.path);
    expect(loadProject).toHaveBeenCalledWith(project.path);
    expect(elements(view, "h2")[0]?.textContent).toBe("Continuity");
  });

  it("renders a clear recoverable empty state", async () => {
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [] } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn() });
    await view.render();
    expect(elements(view, "h2")[0]?.textContent).toBe("Start your research system");
    expect(elements(view, "button").map(({ textContent }) => textContent)).toContain("Create project");
  });
});
