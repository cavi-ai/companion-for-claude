import { App, FakeElement, Platform, TFile, clearNotices, getNoticeMessages } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";
import { WORKFLOWS } from "../../src/workflows/catalog";
import { CHAT_VIEW_TYPE } from "../../src/view/ChatView";
import { INBOX_VIEW_TYPE } from "../../src/view/InboxView";
import { MEMORY_VIEW_TYPE } from "../../src/view/MemoryView";
import { RELATED_VIEW_TYPE } from "../../src/view/RelatedView";
import { SYSTEM_VIEW_TYPE } from "../../src/view/SystemView";
import { ARTIFACT_MAX_TOKENS, WorkspaceViews, type WorkspaceViewsDeps } from "../../src/view/workspaceViews";
import { chatView as buildChatView, inboxView, memoryView } from "../fakes/view";

interface Leaf { parent?: unknown; view: unknown; setViewState: ReturnType<typeof vi.fn> }

const leaf = (view: unknown = {}, parent: unknown = undefined): Leaf => ({ parent, view, setViewState: vi.fn(async () => undefined) });
const chatLeaf = (parent: unknown = undefined): Leaf => leaf(buildChatView(), parent);

interface Rig {
  app: App;
  views: WorkspaceViews;
  settings: PluginSettings;
  workspace: Record<string, unknown>;
  enrichFile: ReturnType<typeof vi.fn>;
  queued: unknown[];
  leaves: Map<string, Leaf[]>;
  rightLeaf: Leaf;
}

function rig(over: { isMobile?: boolean; research?: unknown } = {}): Rig {
  Platform.isMobile = over.isMobile ?? false;
  const app = new App();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const leaves = new Map<string, Leaf[]>();
  const rightLeaf = leaf();
  const workspace = {
    rightSplit: {},
    getLeavesOfType: vi.fn((type: string) => leaves.get(type) ?? []),
    getRightLeaf: vi.fn(() => rightLeaf),
    getLeaf: vi.fn(() => rightLeaf),
    revealLeaf: vi.fn(async () => undefined),
    getActiveFile: vi.fn(() => null),
    getActiveViewOfType: vi.fn(() => null),
  };
  Object.assign(app.workspace, workspace);
  const enrichFile = vi.fn(async () => ({ status: "enriched" }));
  const queued: unknown[] = [];
  const deps: WorkspaceViewsDeps = {
    app,
    settings: () => settings,
    research: () => (over.research ?? {}) as never,
    orders: () => ({ listQueuedEdits: () => queued }) as never,
    enrichment: () => ({ enrichFile }) as never,
  };
  return { app, views: new WorkspaceViews(deps), settings, workspace, enrichFile, queued, leaves, rightLeaf };
}

beforeEach(() => { clearNotices(); });
afterEach(() => { Platform.isMobile = false; vi.useRealTimers(); });

describe("WorkspaceViews chat activation", () => {
  it("opens a right-sidebar chat leaf on desktop when none exists", async () => {
    const r = rig();
    r.rightLeaf.view = buildChatView();
    const view = await r.views.activateView();
    expect(r.rightLeaf.setViewState).toHaveBeenCalledWith({ type: CHAT_VIEW_TYPE, active: true });
    expect(r.workspace.revealLeaf).toHaveBeenCalledWith(r.rightLeaf);
    expect(view).toBe(r.rightLeaf.view);
  });

  it("returns null when the sidebar has no leaf to host the chat", async () => {
    const r = rig();
    (r.workspace.getRightLeaf as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(await r.views.activateView()).toBeNull();
    expect(r.workspace.revealLeaf).not.toHaveBeenCalled();
  });

  it("prefers the most recently focused chat leaf over the first one", async () => {
    const r = rig();
    const first = chatLeaf();
    const second = chatLeaf();
    r.leaves.set(CHAT_VIEW_TYPE, [first, second]);
    r.views.lastFocusedChatLeaf = second as never;
    expect(await r.views.activateView()).toBe(second.view);
    expect(r.workspace.revealLeaf).toHaveBeenCalledWith(second);
    expect(r.workspace.getRightLeaf).not.toHaveBeenCalled();
  });

  it("ignores a remembered leaf that is no longer open", async () => {
    const r = rig();
    const open = chatLeaf();
    r.leaves.set(CHAT_VIEW_TYPE, [open]);
    r.views.lastFocusedChatLeaf = chatLeaf() as never;
    expect(await r.views.activateView()).toBe(open.view);
  });

  it("opens mobile chat in a main tab and skips leaves inside the drawer", async () => {
    const r = rig({ isMobile: true });
    const drawer = r.workspace.rightSplit;
    const inDrawer = chatLeaf(drawer);
    const main = chatLeaf({});
    r.leaves.set(CHAT_VIEW_TYPE, [inDrawer]);
    (r.workspace.getLeaf as ReturnType<typeof vi.fn>).mockReturnValue(main);
    expect(await r.views.activateView()).toBe(main.view);
    expect(main.setViewState).toHaveBeenCalledWith({ type: CHAT_VIEW_TYPE, active: true });
    expect(r.workspace.getRightLeaf).not.toHaveBeenCalled();
  });

  it("opens a new empty chat tab", async () => {
    const r = rig();
    const tab = chatLeaf();
    (r.workspace.getLeaf as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    expect(await r.views.openNewChatTab()).toBe(tab.view);
    expect(tab.setViewState).toHaveBeenCalledWith({ type: CHAT_VIEW_TYPE, active: true, state: { conversationId: null } });
    expect(r.workspace.getLeaf).toHaveBeenCalledWith("tab");
  });
});

describe("WorkspaceViews side views", () => {
  it.each([
    ["activateMemoryView", MEMORY_VIEW_TYPE],
    ["activateInboxView", INBOX_VIEW_TYPE],
    ["activateSystem", SYSTEM_VIEW_TYPE],
    ["activateRelatedView", RELATED_VIEW_TYPE],
  ] as const)("%s opens a sidebar leaf once and reuses it afterwards", async (method, type) => {
    const r = rig();
    r.settings.semanticEnabled = true;
    await r.views[method]();
    expect(r.rightLeaf.setViewState).toHaveBeenCalledWith({ type, active: true });
    expect(r.workspace.revealLeaf).toHaveBeenCalledWith(r.rightLeaf);

    const existing = leaf();
    r.leaves.set(type, [existing]);
    r.rightLeaf.setViewState.mockClear();
    await r.views[method]();
    expect(r.rightLeaf.setViewState).not.toHaveBeenCalled();
    expect(r.workspace.revealLeaf).toHaveBeenLastCalledWith(existing);
  });

  it("tells the user to enable semantic search when opening Related notes without it", async () => {
    const r = rig();
    r.settings.semanticEnabled = false;
    await r.views.activateRelatedView();
    expect(getNoticeMessages()).toEqual(["Turn on semantic search in Companion settings to use related notes."]);
    r.settings.semanticEnabled = true;
    clearNotices();
    await r.views.activateRelatedView();
    expect(getNoticeMessages()).toEqual([]);
  });

  it("renders every open memory view and skips other leaves", async () => {
    const r = rig();
    const memory = memoryView();
    const render = vi.spyOn(memory, "render").mockResolvedValue(undefined);
    r.leaves.set(MEMORY_VIEW_TYPE, [leaf(memory), leaf({})]);
    await r.views.refreshMemoryView();
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceViews chat prompts", () => {
  function chatView() {
    return buildChatView(undefined, {
      submitPrompt: vi.fn(async () => undefined),
      prepareWorkspaceQuestion: vi.fn(),
    });
  }

  it("runs a workflow grounded in the active note, adding vault search when the workflow asks", async () => {
    const r = rig();
    const view = chatView();
    r.rightLeaf.view = view;
    const wf = { ...WORKFLOWS[0]!, vaultSearch: true };
    await r.views.runWorkflow(wf);
    expect(view.submitPrompt).toHaveBeenCalledWith(wf.prompt, wf.name, ARTIFACT_MAX_TOKENS, { context: { activeNote: true, searchVault: true } });
    await r.views.runWorkflow({ ...wf, vaultSearch: false });
    expect(view.submitPrompt).toHaveBeenLastCalledWith(wf.prompt, wf.name, ARTIFACT_MAX_TOKENS, { context: { activeNote: true } });
  });

  it("sends nothing when no chat view can be opened", async () => {
    const r = rig();
    (r.workspace.getRightLeaf as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await expect(r.views.runWorkflow(WORKFLOWS[0]!)).resolves.toBeUndefined();
    await expect(r.views.generateArtifactFromContext()).resolves.toBeUndefined();
    await expect(r.views.askCompanionAboutProject("Research/p")).resolves.toBeUndefined();
  });

  it("turns the selection, or else the note, into an artifact", async () => {
    const r = rig();
    const view = chatView();
    r.rightLeaf.view = view;
    await r.views.generateArtifactFromContext();
    expect(view.submitPrompt).toHaveBeenLastCalledWith(expect.stringContaining("my current note"), "Turn my current note into an artifact", ARTIFACT_MAX_TOKENS, { context: { activeNote: true, selection: true } });
    (r.app.workspace as unknown as { getActiveViewOfType: unknown }).getActiveViewOfType = () => ({ editor: { getSelection: () => "  picked " } });
    await r.views.generateArtifactFromContext();
    expect(view.submitPrompt).toHaveBeenLastCalledWith(expect.stringContaining("the selected text"), "Turn the selected text into an artifact", ARTIFACT_MAX_TOKENS, { context: { activeNote: true, selection: true } });
  });

  it("prepares a research question on the chat view", async () => {
    const r = rig();
    const view = chatView();
    r.rightLeaf.view = view;
    await r.views.askCompanionAboutProject("Research/p");
    expect(view.prepareWorkspaceQuestion).toHaveBeenCalledWith({ kind: "research", title: "Continue this research project", contextPath: "Research/p" });
  });
});

describe("WorkspaceViews active note card", () => {
  it("is null without a markdown note", async () => {
    const r = rig();
    expect(await r.views.companionWorkspaceContext()).toBeNull();
    const pdf = new TFile("a.pdf", "", 0);
    (r.app.workspace as unknown as { getActiveFile: unknown }).getActiveFile = () => pdf;
    expect(await r.views.companionWorkspaceContext()).toBeNull();
  });

  it("describes a plain note when it belongs to no research project", async () => {
    const r = rig();
    const note = r.app.vault.seed("Notes/Idea.md", "text");
    (r.app.workspace as unknown as { getActiveFile: unknown }).getActiveFile = () => note;
    const card = await r.views.companionWorkspaceContext();
    expect(card).toMatchObject({ kind: "note", contextPath: "Notes/Idea.md" });
  });

  it("falls back to the plain note card when the research project cannot load", async () => {
    const loadProject = vi.fn(async () => { throw new Error("missing"); });
    const r = rig({ research: { researchRepository: () => ({ loadProject }) } });
    const note = r.app.vault.seed("Research/p/Notes/Idea.md", "text", { frontmatter: { research_project: "Research/p/Project.md" } });
    (r.app.workspace as unknown as { getActiveFile: unknown }).getActiveFile = () => note;
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const card = await r.views.companionWorkspaceContext();
    debug.mockRestore();
    expect(card?.kind).toBe("note");
  });
});

describe("WorkspaceViews inbox", () => {
  it("enriches a file and refreshes open inbox views, with consent prompting unless inline", async () => {
    const r = rig();
    const inbox = inboxView();
    const render = vi.spyOn(inbox, "render").mockResolvedValue(undefined);
    r.leaves.set(INBOX_VIEW_TYPE, [leaf(inbox), leaf({})]);
    const file = new TFile("Clippings/a.md", "", 0);
    await expect(r.views.enrichInboxItem(file)).resolves.toEqual({ status: "enriched" });
    expect(r.enrichFile).toHaveBeenLastCalledWith(file, true);
    expect(render).toHaveBeenCalledTimes(1);
    await r.views.enrichInboxItem(file, { inline: true });
    expect(r.enrichFile).toHaveBeenLastCalledWith(file, false);
  });

  it("skips the refresh on request and survives a failing inbox render", async () => {
    const r = rig();
    const inbox = inboxView();
    const render = vi.spyOn(inbox, "render").mockRejectedValue(new Error("paint failed"));
    r.leaves.set(INBOX_VIEW_TYPE, [leaf(inbox)]);
    const file = new TFile("Clippings/a.md", "", 0);
    await r.views.enrichInboxItem(file, { refreshInboxViews: false });
    expect(render).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(r.views.enrichInboxItem(file)).resolves.toEqual({ status: "enriched" });
    expect(warn).toHaveBeenCalledWith("[companion] Inbox refresh failed", expect.any(Error));
    warn.mockRestore();
  });

  it("counts the unenriched files in the configured inbox folder", () => {
    const r = rig();
    r.settings.sourceInboxFolder = "Clippings";
    r.app.vault.seed("Clippings/a.md", "a");
    r.app.vault.seed("Clippings/b.md", "b", { frontmatter: { source_enriched: true } });
    r.app.vault.seed("Notes/c.md", "c");
    expect(r.views.inboxPendingCount()).toBe(1);
  });

  it("labels the ribbon with pending and queued counts and clears the badge when nothing waits", () => {
    const r = rig();
    const ribbon = new FakeElement();
    r.views.setInboxRibbon(ribbon as unknown as HTMLElement);
    r.settings.sourceCaptureEnabled = true;
    r.settings.sourceInboxFolder = "Clippings";
    r.app.vault.seed("Clippings/a.md", "a");
    r.queued.push({}, {});
    r.views.syncInboxBadge();
    expect(ribbon.getAttr("aria-label")).toBe("Source inbox — 1 to type, 2 to review");
    expect(ribbon.querySelector(".cc-inbox-ribbon-badge")?.textContent).toBe("3");

    r.queued.length = 0;
    r.settings.sourceCaptureEnabled = false;
    r.views.syncInboxBadge();
    expect(ribbon.getAttr("aria-label")).toBe("Source inbox");
    expect(ribbon.querySelector(".cc-inbox-ribbon-badge")).toBeNull();
  });

  it("does nothing before a ribbon is attached", () => {
    const r = rig();
    expect(() => r.views.syncInboxBadge()).not.toThrow();
  });

  it("debounces badge refreshes to 800 ms and cancels a pending one on dispose", () => {
    vi.useFakeTimers();
    const r = rig();
    const ribbon = new FakeElement();
    r.views.setInboxRibbon(ribbon as unknown as HTMLElement);
    r.settings.sourceCaptureEnabled = true;
    r.settings.sourceInboxFolder = "Clippings";
    r.app.vault.seed("Clippings/a.md", "a");

    r.views.scheduleInboxBadgeSync();
    vi.advanceTimersByTime(799);
    r.views.scheduleInboxBadgeSync();
    vi.advanceTimersByTime(799);
    expect(ribbon.getAttr("aria-label")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(ribbon.getAttr("aria-label")).toBe("Source inbox — 1 to type");

    r.views.scheduleInboxBadgeSync();
    expect(vi.getTimerCount()).toBe(1);
    r.views.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
