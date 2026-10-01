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
    expect(elements(view, ".cc-desk-next-reason")[0]?.textContent).toMatch(/source changed/i);
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

  it("shows the research model chip and opens settings from it", async () => {
    const openResearchSettings = vi.fn();
    const status = { model: "chat" as const, providerLabel: "Claude Code", modelId: "sonnet", available: true };
    const make = (researchStatus: () => typeof status) => new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [project], loadProject: async () => snapshot } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn(), researchStatus, openResearchSettings });
    const view = make(() => status);
    await view.setProjectPath(project.path);
    const chip = elements(view, ".cc-research-model-chip")[0];
    expect(chip?.textContent).toBe("AI · Claude Code · sonnet");
    expect(chip?.getAttribute("aria-label")).toBe("Research model: AI · Claude Code · sonnet. Open settings");
    click(chip);
    expect(openResearchSettings).toHaveBeenCalledOnce();
    const down = make(() => ({ ...status, available: false }));
    await down.setProjectPath(project.path);
    const unavailable = elements(down, ".cc-research-model-chip")[0];
    expect(unavailable?.textContent).toBe("AI · set up Claude Code");
    expect(unavailable?.classList.has("is-unavailable")).toBe(true);
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
    expect(loadProject).toHaveBeenCalledWith(other.path, { refreshBinaryFingerprints: true });
    expect(view.getProjectPath()).toBe(other.path);
  });

  it("opens the first deterministic project instead of showing an empty desk", async () => {
    const other = { ...project, path: "Research/Other/Project.md", project: "Research/Other/Project.md", title: "Other" };
    const loadProject = vi.fn(async () => snapshot);
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [project, other], loadProject } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn() });
    await view.render();
    expect(view.getProjectPath()).toBe(project.path);
    expect(loadProject).toHaveBeenCalledWith(project.path, { refreshBinaryFingerprints: true });
    expect(elements(view, "h2")[0]?.textContent).toBe("Continuity");
  });

  it("renders a clear recoverable empty state", async () => {
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [] } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn() });
    await view.render();
    expect(elements(view, "h2")[0]?.textContent).toBe("Start your research system");
    expect(elements(view, "button").map(({ textContent }) => textContent)).toContain("Create project");
  });

  it("reports an unavailable PDF as unverifiable without claiming its content changed", async () => {
    const unavailable = buildProjectSnapshot(project.path, records.map((record) => record.type === "research-source"
      ? { ...record, sourceKind: "pdf", asset: "Research/P/Sources/assets/S.pdf", contentFingerprint: undefined, contentFingerprintUnavailable: true }
      : record.type === "evidence" ? { ...record, sourceFingerprint: "sha256:prior" } : record), []);
    const openWorkbench = vi.fn(async () => undefined);
    const view = new ResearchDeskView(new WorkspaceLeaf(), {
      listProjects: async () => [project], loadProject: async () => unavailable,
      loadDraftSections: async () => ({ issues: [], sections: [] }),
    } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench });

    await view.setProjectPath(project.path);

    expect(elements(view, ".cc-desk-next-reason")[0]?.textContent).toMatch(/can't be read/i);
    expect(elements(view, ".cc-desk-next-reason")[0]?.textContent).not.toMatch(/source changed/i);
    click(elements(view, "button").find(({ textContent }) => textContent === "Start this task"));
    await Promise.resolve();
    expect(openWorkbench).toHaveBeenCalledWith(project.path, "Audit", "Research/P/Sources/S.md");
  });

  it("runs the top action through the shared actions instead of switching tabs", async () => {
    const actions = { run: vi.fn(async () => undefined), createProject: vi.fn(), addSource: vi.fn(), extractEvidence: vi.fn(), createClaim: vi.fn(), buildOutline: vi.fn() };
    const openWorkbench = vi.fn(async () => undefined);
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [project], loadProject: async () => snapshot, loadDraftSections: async () => ({ issues: [], sections: [] }) } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench, actions: actions as never });
    await view.setProjectPath(project.path);
    click(elements(view, "button").find(({ textContent }) => textContent === "Start this task"));
    await Promise.resolve();
    expect(actions.run).toHaveBeenCalledWith(expect.objectContaining({ id: "stale-evidence:Research/P/Evidence/E.md", run: "review-evidence" }), snapshot);
    expect(openWorkbench).not.toHaveBeenCalled();
    click(elements(view, ".cc-desk-attention-row")[0]);
    await Promise.resolve();
    expect(actions.run).toHaveBeenCalledTimes(2);
    expect(elements(view, "span").map(({ textContent }) => textContent)).toContain("Start →");
    click(elements(view, "button").find(({ textContent }) => textContent === "Add source"));
    expect(actions.addSource).toHaveBeenCalledWith(project.path);
    click(elements(view, "button").find(({ textContent }) => textContent === "Develop claim"));
    expect(actions.createClaim).toHaveBeenCalledWith(snapshot);
    click(elements(view, "button").find(({ textContent }) => textContent === "Extract evidence"));
    expect(actions.extractEvidence).toHaveBeenCalledWith(snapshot, "Research/P/Sources/S.md");
  });

  it("disables quick actions that have nothing to work on and offers Build outline before a draft exists", async () => {
    const bare = buildProjectSnapshot(project.path, [project], []);
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [project], loadProject: async () => bare } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn(), actions: {} as never });
    await view.setProjectPath(project.path);
    const button = (label: string) => elements(view, "button").find(({ textContent }) => textContent === label) as unknown as { disabled?: boolean; getAttribute(name: string): string | null };
    expect(button("Extract evidence").disabled).toBe(true);
    expect(button("Extract evidence").getAttribute("title")).toBe("Add a source first");
    expect(button("Develop claim").disabled).toBe(true);
    expect(button("Develop claim").getAttribute("title")).toBe("Check a passage first");
    expect(button("Build outline")).toBeDefined();
    expect(button("Continue draft")).toBeUndefined();
  });

  it("creates a project from the empty state through the shared actions", async () => {
    const actions = { createProject: vi.fn() };
    const view = new ResearchDeskView(new WorkspaceLeaf(), { listProjects: async () => [] } as never, { preferencesFor: () => ({ dismissedActionIds: [] }), updatePreferences: vi.fn(), openWorkbench: vi.fn(), actions: actions as never });
    await view.render();
    click(elements(view, "button").find(({ textContent }) => textContent === "Create project"));
    expect(actions.createProject).toHaveBeenCalledOnce();
  });
});
