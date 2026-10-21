import { App, MarkdownView, TFile, WorkspaceLeaf, clearNotices, getNoticeMessages, getLastOpenedModal, type FakeElement } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { PLANNING_INSTRUCTION } from "../../src/artifacts/designSystem";
import { ResearchFeature, type ResearchFeatureDeps } from "../../src/research/researchFeature";
import { DEFAULT_SETTINGS } from "../../src/types";
import { BUILD_VIEW_TYPE } from "../../src/view/BuildView";
import { ResearchView, RESEARCH_DESK_VIEW_TYPE } from "../../src/view/ResearchView";
import { buildView, researchView } from "../fakes/view";

const modals = vi.hoisted(() => [] as Array<{ submit: (input: unknown) => Promise<void>; rewriteText: unknown; initial: Record<string, unknown> }>);
vi.mock("../../src/view/research/projectCreateModal", () => ({
  ProjectCreateModal: class {
    constructor(_app: unknown, submit: (input: unknown) => Promise<void>, rewriteText: unknown, initial: Record<string, unknown>) { modals.push({ submit, rewriteText, initial }); }
    open(): void {}
  },
}));

const LONG = `# Note\n\n${"Some grounded text about raft leader election. ".repeat(10)}`;

interface Rig {
  app: App;
  feature: ResearchFeature;
  view: { attachNote: ReturnType<typeof vi.fn>; submitPrompt: ReturnType<typeof vi.fn> };
  build: { handoffToBuild: ReturnType<typeof vi.fn>; activeBuildRun: ReturnType<typeof vi.fn>; selectActiveRun: ReturnType<typeof vi.fn> };
  deps: ResearchFeatureDeps;
  router: Record<string, unknown>;
  lastMarkdownFile: { value: TFile | null };
}

function rig(over: { activateView?: ResearchFeatureDeps["activateView"] } = {}): Rig {
  const app = new App();
  const view = { attachNote: vi.fn(), submitPrompt: vi.fn(async () => true) };
  const build = { handoffToBuild: vi.fn(async () => "run-1"), activeBuildRun: vi.fn(() => null), selectActiveRun: vi.fn() };
  const router: Record<string, unknown> = { researchSelection: () => null, researchStatus: () => ({ enabled: false }) };
  const lastMarkdownFile = { value: null as TFile | null };
  const deps: ResearchFeatureDeps = {
    app,
    settings: () => DEFAULT_SETTINGS,
    activity: () => new ActivityStore(),
    router: () => router as never,
    build: () => build as never,
    activateView: over.activateView ?? (async () => view as never),
    lastMarkdownFile: () => lastMarkdownFile.value,
    companionChrome: () => ({ app }) as never,
    openCompanionSettings: vi.fn(),
    artifactMaxTokens: 1234,
  };
  return { app, feature: new ResearchFeature(deps), view, build, deps, router, lastMarkdownFile };
}

function workspace(app: App, leaves: Record<string, unknown[]>, extra: Record<string, unknown> = {}): void {
  Object.assign(app.workspace, {
    getLeavesOfType: (type: string) => leaves[type] ?? [],
    getActiveViewOfType: () => null,
    getActiveFile: () => null,
    ...extra,
  });
}

function planLeaf(app: App, path: string, type: string | undefined): { leaf: { view: MarkdownView }; action: { remove: ReturnType<typeof vi.fn> }; addAction: ReturnType<typeof vi.fn> } {
  const file = app.vault.seed(path, "x", type ? { frontmatter: { type } } : {});
  const action = { remove: vi.fn() };
  const addAction = vi.fn(() => action);
  const view = Object.assign(new MarkdownView(), { file, addAction });
  return { leaf: { view }, action, addAction };
}

beforeEach(() => { clearNotices(); modals.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("ResearchFeature plan notes", () => {
  it("adds one Build action to a plan note and removes it when the note stops being a plan", () => {
    const { app, feature } = rig();
    const { leaf, action, addAction } = planLeaf(app, "Plans/A.md", "plan");
    workspace(app, { markdown: [leaf] });
    feature.syncPlanBuildActions();
    feature.syncPlanBuildActions();
    expect(addAction).toHaveBeenCalledTimes(1);
    expect(addAction.mock.calls[0]!.slice(0, 2)).toEqual(["hammer", "Build this plan with Claude"]);
    app.vault.frontmatters.set("Plans/A.md", { type: "note" });
    feature.syncPlanBuildActions();
    expect(action.remove).toHaveBeenCalledTimes(1);
  });

  it("leaves non-plan notes alone", () => {
    const { app, feature } = rig();
    const { leaf, addAction } = planLeaf(app, "Notes/B.md", undefined);
    workspace(app, { markdown: [leaf] });
    feature.syncPlanBuildActions();
    expect(addAction).not.toHaveBeenCalled();
  });

  it("the Build action hands the plan note to the build controller", async () => {
    const { app, feature, build } = rig();
    const { leaf, addAction } = planLeaf(app, "Plans/A.md", "plan");
    workspace(app, { markdown: [leaf] }, { getRightLeaf: () => null });
    feature.syncPlanBuildActions();
    (addAction.mock.calls[0] as unknown as [string, string, () => void])[2]();
    await vi.waitFor(() => expect(build.handoffToBuild).toHaveBeenCalledWith({ path: "Plans/A.md", basename: "A" }));
    expect(build.selectActiveRun).toHaveBeenCalledWith("run-1");
  });

  it("marking a note as a plan stamps the frontmatter and announces the Build icon", async () => {
    const { app, feature } = rig();
    workspace(app, { markdown: [] });
    const file = app.vault.seed("Plans/C.md", "---\ntitle: C\n---\nbody");
    await feature.markNoteAsPlan(file);
    expect(file._content).toContain('type: "plan"');
    expect(getNoticeMessages()).toEqual(["Marked as a plan — a Build icon is now in the note's header."]);
  });
});

describe("ResearchFeature build handoff", () => {
  it("does not open the Build view when the handoff declines", async () => {
    const { app, feature, build } = rig();
    workspace(app, {});
    build.handoffToBuild.mockResolvedValue(null);
    const open = vi.spyOn(feature, "activateBuildView");
    await feature.handoffToBuild(app.vault.seed("Plans/D.md", "x"));
    expect(open).not.toHaveBeenCalled();
  });

  it("reveals the Build view and gives it the active run", async () => {
    const { app, feature, build } = rig();
    const run = { id: "run-1" };
    build.activeBuildRun.mockReturnValue(run);
    const setRun = vi.fn();
    const view = buildView(undefined, { setRun });
    const reveal = vi.fn(async () => undefined);
    workspace(app, { [BUILD_VIEW_TYPE]: [{ view }] }, { revealLeaf: reveal });
    await expect(feature.activateBuildView("run-1")).resolves.toBe(view);
    expect(build.selectActiveRun).toHaveBeenCalledWith("run-1");
    expect(setRun).toHaveBeenCalledWith(run);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("generates a plan prompt grounded in the current note", async () => {
    const { feature, view } = rig();
    await feature.generatePlanFromNote();
    expect(view.submitPrompt).toHaveBeenCalledWith(
      `${PLANNING_INSTRUCTION}\n\nBase the plan entirely on the content of my current note.`,
      "Generate an implementation plan from this note",
      1234,
      { context: { activeNote: true } },
    );
  });

  it("does nothing when the chat view cannot open", async () => {
    const { feature } = rig({ activateView: async () => null });
    await expect(feature.generatePlanFromNote()).resolves.toBeUndefined();
  });
});

describe("ResearchFeature chat hand-off", () => {
  it("attaches the project note and submits the research prompt", async () => {
    const { feature, view } = rig();
    await expect(feature.askResearch("R/Project.md", "prompt", "display")).resolves.toBe(true);
    expect(view.attachNote).toHaveBeenCalledWith("R/Project.md");
    expect(view.submitPrompt).toHaveBeenCalledWith("prompt", "display");
  });

  it("does not infer a busy reply from an unaccepted prompt", async () => {
    const { feature, view } = rig();
    view.submitPrompt.mockResolvedValue(false);
    await expect(feature.askResearch("R/Project.md", "p", "d")).resolves.toBe(false);
    expect(getNoticeMessages()).toEqual([]);
  });

  it("returns false without a chat view", async () => {
    const { feature } = rig({ activateView: async () => null });
    await expect(feature.askResearch("R/Project.md", "p", "d")).resolves.toBe(false);
  });
});

describe("ResearchFeature desk activation", () => {
  it("opens a new desk in a central tab without replacing side chat", async () => {
    const { app, feature } = rig();
    const leaf = { setViewState: vi.fn(async () => undefined), view: {} };
    const getLeaf = vi.fn(() => leaf);
    const getRightLeaf = vi.fn();
    workspace(app, {}, { getLeaf, getRightLeaf, revealLeaf: vi.fn() });
    await feature.activateResearchDesk();
    expect(getLeaf).toHaveBeenCalledWith("tab");
    expect(getRightLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: RESEARCH_DESK_VIEW_TYPE, active: true });
  });
  it("selects the requested project on the open Research Desk and reveals it", async () => {
    const { app, feature } = rig();
    const setProjectPath = vi.fn(async () => undefined);
    const desk = researchView(undefined, undefined, { getProjectPath: () => "R/Old/Project.md", setProjectPath });
    const reveal = vi.fn(async () => undefined);
    workspace(app, { "claude-research-desk": [{ view: desk }] }, { revealLeaf: reveal });
    await feature.activateResearchDesk("R/New/Project.md");
    expect(setProjectPath).toHaveBeenCalledWith("R/New/Project.md");
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("keeps the selection when the requested project is already open", async () => {
    const { app, feature } = rig();
    const setProjectPath = vi.fn(async () => undefined);
    const desk = researchView(undefined, undefined, { getProjectPath: () => "R/Same/Project.md", setProjectPath });
    workspace(app, { "claude-research-desk": [{ view: desk }] }, { revealLeaf: async () => undefined });
    await feature.activateResearchDesk("R/Same/Project.md");
    expect(setProjectPath).not.toHaveBeenCalled();
  });

  it("builds a Research Desk view for a leaf", () => {
    const { app, feature } = rig();
    expect(feature.createDeskView(new WorkspaceLeaf(app))).toBeInstanceOf(ResearchView);
  });
});

describe("ResearchFeature refresh", () => {
  function deskWith(relevant: boolean | ((path: string) => boolean)) {
    const render = vi.fn(async () => undefined);
    const isRelevantChange = vi.fn((path: string, _oldPath?: string) => (typeof relevant === "function" ? relevant(path) : relevant));
    return { render, isRelevantChange, view: researchView(undefined, undefined, { render, isRelevantChange }) };
  }

  it("renders the open desk once, 250 ms after the last relevant change", async () => {
    vi.useFakeTimers();
    const { app, feature } = rig();
    const desk = deskWith((path) => path === "b.md");
    workspace(app, { [RESEARCH_DESK_VIEW_TYPE]: [{ view: desk.view }] });
    feature.scheduleResearchRefresh("a.md");
    await vi.advanceTimersByTimeAsync(200);
    feature.scheduleResearchRefresh("b.md", "old.md");
    await vi.advanceTimersByTimeAsync(249);
    expect(desk.render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(desk.render).toHaveBeenCalledTimes(1);
    expect(desk.isRelevantChange).toHaveBeenCalledWith("a.md", undefined);
    expect(desk.isRelevantChange).toHaveBeenCalledWith("b.md", "old.md");
  });

  it("skips the render when no change touches the project", async () => {
    vi.useFakeTimers();
    const { app, feature } = rig();
    const desk = deskWith(false);
    workspace(app, { "claude-research-desk": [{ view: desk.view }] });
    feature.scheduleResearchRefresh("unrelated.md");
    await vi.advanceTimersByTimeAsync(300);
    expect(desk.render).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending refresh", async () => {
    vi.useFakeTimers();
    const { app, feature } = rig();
    const desk = deskWith(true);
    workspace(app, { "claude-research-desk": [{ view: desk.view }] });
    feature.scheduleResearchRefresh("a.md");
    feature.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(desk.render).not.toHaveBeenCalled();
  });
});

describe("ResearchFeature discovery coordinators", () => {
  it("shares one lazy coordinator and isolates view coordinators", () => {
    const { feature } = rig();
    expect(feature.discoveryCoordinator()).toBe(feature.discoveryCoordinator());
    const a = feature.createDiscoveryCoordinator();
    const b = feature.createDiscoveryCoordinator();
    expect(a).not.toBe(b);
    expect(a).not.toBe(feature.discoveryCoordinator());
  });

  it("releases a view coordinator once and ignores a second release", () => {
    const { feature } = rig();
    const a = feature.createDiscoveryCoordinator();
    const cancel = vi.spyOn(a, "cancel");
    const clear = vi.spyOn(a, "clearCache");
    feature.releaseDiscoveryCoordinator(a);
    feature.releaseDiscoveryCoordinator(a);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("retains an external coordinator so dispose and cache clears reach it", () => {
    const { feature } = rig();
    const external = feature.createDiscoveryCoordinator();
    feature.releaseDiscoveryCoordinator(external);
    feature.retainDiscoveryCoordinator(external);
    const clear = vi.spyOn(external, "clearCache");
    feature.clearDiscoveryCache();
    expect(clear).toHaveBeenCalledTimes(1);
    const cancel = vi.spyOn(external, "cancel");
    feature.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels and clears every coordinator and starts the shared one fresh", () => {
    const { feature } = rig();
    const shared = feature.discoveryCoordinator();
    const view = feature.createDiscoveryCoordinator();
    const sharedCancel = vi.spyOn(shared, "cancel");
    const viewCancel = vi.spyOn(view, "cancel");
    const viewClear = vi.spyOn(view, "clearCache");
    feature.dispose();
    expect(sharedCancel).toHaveBeenCalledTimes(1);
    expect(viewCancel).toHaveBeenCalledTimes(1);
    expect(viewClear).toHaveBeenCalledTimes(1);
    expect(feature.discoveryCoordinator()).not.toBe(shared);
  });
});

describe("ResearchFeature project seeding", () => {
  function seeded(content: string) {
    const r = rig();
    const file = r.app.vault.seed("Notes/Raft.md", content);
    r.lastMarkdownFile.value = file;
    workspace(r.app, {});
    const repo = {
      createProject: vi.fn(async () => ({ path: "Research/Raft/Project.md" })),
      importSource: vi.fn(async () => undefined),
    };
    Object.defineProperty(r.feature, "researchRepository", { value: () => repo });
    const activate = vi.spyOn(r.feature, "activateResearchDesk").mockResolvedValue(undefined);
    return { ...r, file, repo, activate };
  }

  it("asks for a note when none is open", async () => {
    const { feature, app } = rig();
    workspace(app, {});
    await feature.startResearchFromActiveNote();
    expect(getNoticeMessages()).toEqual(["Open a note first — it becomes the project's first source."]);
    expect(modals).toHaveLength(0);
  });

  it("refuses a note that is too short", async () => {
    const { feature } = seeded("tiny");
    await feature.startResearchFromActiveNote();
    expect(getNoticeMessages()).toEqual(["That note is too short to seed a research project."]);
    expect(modals).toHaveLength(0);
  });

  it("opens the create modal without a drafted question when Research AI is off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { feature } = seeded(LONG);
    await feature.startResearchFromActiveNote();
    expect(warn).toHaveBeenCalledWith("[companion] question drafting failed", expect.any(Error));
    expect(modals).toHaveLength(1);
    expect(modals[0]!.initial).toEqual({ title: "Raft", folder: "Research/Raft" });
  });

  it("drafts the question from the note and pre-fills the modal", async () => {
    const { feature, router } = seeded(LONG);
    router.researchSelection = () => ({ provider: {}, model: "m" });
    router.completeResolved = vi.fn(async () => ({ text: "What drives raft leader election?" }));
    await feature.startResearchFromActiveNote();
    expect(modals[0]!.initial).toEqual({ title: "Raft", folder: "Research/Raft", question: expect.stringContaining("raft leader election") });
    expect((router.completeResolved as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({ provider: {}, model: "m" });
  });

  it("creates the project, imports the note as the first source and opens the desk", async () => {
    const { feature, repo, activate } = seeded(`---\nurl: https://example.test/raft\n---\n${LONG}`);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await feature.startResearchFromActiveNote();
    await modals[0]!.submit({ title: "Raft" });
    expect(repo.createProject).toHaveBeenCalledWith({ title: "Raft" });
    expect(repo.importSource).toHaveBeenCalledWith("Research/Raft/Project.md", expect.objectContaining({ title: "Raft", sourceKind: "vault", capturedContent: expect.stringContaining("raft leader election") }));
    expect(activate).toHaveBeenCalledWith("Research/Raft/Project.md");
    expect(getNoticeMessages()).toContain("Project started with “Raft” as the first source.");
  });
  const recoveryButton = (name: string) => [...getLastOpenedModal()!.contentEl.querySelectorAll("button")].find((button) => button.textContent === name)!;
  const click = (button: HTMLButtonElement) => (button as unknown as FakeElement).dispatchEvent({ type: "click" });
  const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

  it("keeps a created project and retries only the failed source import", async () => {
    const { feature, repo, activate } = seeded(LONG);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    repo.importSource.mockRejectedValueOnce(new Error("Source write unavailable"));
    await feature.startResearchFromActiveNote();
    await expect(modals[0]!.submit({ title: "Raft" })).resolves.toBeUndefined();
    const modal = getLastOpenedModal()!;
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("Source write unavailable");
    click(recoveryButton("Retry adding source"));
    await settle();
    expect(repo.createProject).toHaveBeenCalledTimes(1);
    expect(repo.importSource).toHaveBeenCalledTimes(2);
    expect(repo.importSource.mock.calls[1]).toEqual(repo.importSource.mock.calls[0]);
    expect(activate).toHaveBeenCalledWith("Research/Raft/Project.md");
    expect(modal.closed).toBe(true);
  });

  it("lets the user open the created project without retrying the source", async () => {
    const { feature, repo, activate } = seeded(LONG);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    repo.importSource.mockRejectedValueOnce(new Error("Source write unavailable"));
    await feature.startResearchFromActiveNote();
    await modals[0]!.submit({ title: "Raft" });
    const modal = getLastOpenedModal()!;
    click(recoveryButton("Open project"));
    await settle();
    expect(repo.createProject).toHaveBeenCalledTimes(1);
    expect(repo.importSource).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith("Research/Raft/Project.md");
    expect(modal.closed).toBe(true);
  });

  it("keeps recovery available after another source save fails", async () => {
    const { feature, repo } = seeded(LONG);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    repo.importSource.mockRejectedValueOnce(new Error("First failure")).mockRejectedValueOnce(new Error("Still unavailable"));
    await feature.startResearchFromActiveNote();
    await modals[0]!.submit({ title: "Raft" });
    const modal = getLastOpenedModal()!;
    click(recoveryButton("Retry adding source"));
    await settle();
    expect(modal.closed).toBe(false);
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("Still unavailable");
    expect(recoveryButton("Retry adding source").disabled).toBe(false);
    click(recoveryButton("Retry adding source"));
    await settle();
    expect(modal.closed).toBe(true);
    expect(repo.createProject).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated retries and does not navigate after recovery is closed", async () => {
    const { feature, repo, activate } = seeded(LONG);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish!: () => void;
    repo.importSource.mockRejectedValueOnce(new Error("Source write unavailable")).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await feature.startResearchFromActiveNote();
    await modals[0]!.submit({ title: "Raft" });
    const modal = getLastOpenedModal()!;
    const retry = recoveryButton("Retry adding source");
    click(retry);
    click(retry);
    await settle();
    expect(repo.importSource).toHaveBeenCalledTimes(2);
    modal.close();
    finish();
    await settle();
    expect(activate).not.toHaveBeenCalled();
    expect(repo.createProject).toHaveBeenCalledTimes(1);
  });

});
