import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, TFile, clearNotices, getNoticeMessages } from "obsidian";

type Deps = Record<string, (...args: never[]) => unknown>;

const captured = vi.hoisted(() => ({
  conversations: undefined as Deps | undefined,
  distill: undefined as Deps | undefined,
  session: undefined as Deps | undefined,
  unattached: undefined as ((info: unknown) => void) | undefined,
  counts: { conversations: 0, distill: 0, session: 0, turn: 0 },
  list: vi.fn(),
  setDistilledNote: vi.fn(),
  archive: vi.fn(),
  fork: vi.fn(),
  createSeeded: vi.fn(),
  distillCall: vi.fn(),
  saveSummaryNote: vi.fn(),
}));

vi.mock("../../src/conversations/controller", () => ({
  ConversationsController: class {
    constructor(deps: Deps) {
      captured.conversations = deps;
      captured.counts.conversations++;
    }
    list = captured.list;
    setDistilledNote = captured.setDistilledNote;
    archive = captured.archive;
    fork = captured.fork;
    createSeeded = captured.createSeeded;
  },
}));
vi.mock("../../src/conversations/distillController", () => ({
  DistillController: class {
    constructor(deps: Deps) {
      captured.distill = deps;
      captured.counts.distill++;
    }
    distill = captured.distillCall;
  },
}));
vi.mock("../../src/conversations/sessionActions", () => ({
  SessionActions: class {
    constructor(deps: Deps) {
      captured.session = deps;
      captured.counts.session++;
    }
  },
}));
vi.mock("../../src/chat/turnService", () => ({
  ChatTurnService: class {
    constructor() {
      captured.counts.turn++;
    }
    onUnattachedDone(callback: (info: unknown) => void): void {
      captured.unattached = callback;
    }
  },
}));
vi.mock("../../src/artifacts/artifactStore", () => ({ saveSummaryNote: captured.saveSummaryNote }));
vi.mock("../../src/view/ChatView", () => ({ CHAT_VIEW_TYPE: "claude-companion-chat" }));

import { buildChat, type ChatHost, type ChatWiring } from "../../src/composition/chat";

const file = (path: string): TFile => new TFile(path, "", 0);
const dep = (deps: Deps | undefined, name: string, ...args: unknown[]): unknown => (deps![name] as (...a: unknown[]) => unknown)(...args);

function rig(over: { notify?: boolean } = {}) {
  const m = {
    persist: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ text: "completed" })),
    getAbstractFileByPath: vi.fn((_path: string): unknown => null),
    getFirstLinkpathDest: vi.fn((_link: string, _from: string): { path: string } | null => null),
    modify: vi.fn(async () => undefined),
    cachedRead: vi.fn(async () => "body"),
    setViewState: vi.fn(async () => undefined),
    revealLeaf: vi.fn(async () => undefined),
    getLeaf: vi.fn(),
    set: vi.fn(),
    onUnattachedTurnDone: vi.fn(),
  };
  const leaf = { setViewState: m.setViewState };
  m.getLeaf.mockReturnValue(leaf);
  const activity = { activity: true };
  const settings = { chatFolder: "Chats", chatBaseTags: [], notifyOnTurnComplete: over.notify ?? true };
  const router = { complete: m.complete };
  const host = {
    app: {
      vault: { getAbstractFileByPath: m.getAbstractFileByPath, modify: m.modify, cachedRead: m.cachedRead },
      metadataCache: { getFirstLinkpathDest: m.getFirstLinkpathDest },
      workspace: { getLeaf: m.getLeaf, revealLeaf: m.revealLeaf },
    },
    activity,
    settings,
    persist: m.persist,
    router: () => router,
  } as unknown as ChatHost;
  const state = { conv: "state" };
  const wiring: ChatWiring = {
    state: { get: () => state as never, set: m.set },
    onUnattachedTurnDone: m.onUnattachedTurnDone,
  };
  return { host, wiring, m, leaf, activity, settings, router, state };
}

beforeEach(() => {
  captured.conversations = undefined;
  captured.distill = undefined;
  captured.session = undefined;
  captured.unattached = undefined;
  captured.counts = { conversations: 0, distill: 0, session: 0, turn: 0 };
  for (const fn of [captured.list, captured.setDistilledNote, captured.archive, captured.fork, captured.createSeeded, captured.distillCall, captured.saveSummaryNote]) fn.mockReset();
  clearNotices();
});

afterEach(() => { Platform.isMobile = false; });

describe("buildChat conversations", () => {
  it("maps state, persist, activity and settings to the host", async () => {
    const r = rig();
    buildChat(r.host, r.wiring).conversations();
    const state = (captured.conversations as unknown as ChatWiring).state;
    expect(state.get()).toBe(r.state);
    const next = { next: true } as never;
    state.set(next);
    expect(r.m.set).toHaveBeenCalledWith(next);
    await dep(captured.conversations, "persist");
    expect(r.m.persist).toHaveBeenCalledTimes(1);
    expect(dep(captured.conversations, "activity")).toBe(r.activity);
    expect(dep(captured.conversations, "settings")).toBe(r.settings);
  });
});

describe("buildChat distiller", () => {
  it("finds a conversation by id through the controller list", () => {
    const r = rig();
    captured.list.mockReturnValue([{ id: "a" }, { id: "b" }]);
    buildChat(r.host, r.wiring).distiller();
    expect(dep(captured.distill, "get", "b")).toEqual({ id: "b" });
    expect(dep(captured.distill, "get", "z")).toBeUndefined();
  });

  it("completes through the utility route and returns the text", async () => {
    const r = rig();
    buildChat(r.host, r.wiring).distiller();
    const req = { system: "s" };
    await expect(dep(captured.distill, "complete", req)).resolves.toBe("completed");
    expect(r.m.complete).toHaveBeenCalledWith("utility", req);
  });

  it("exists is true only for a TFile", () => {
    const r = rig();
    buildChat(r.host, r.wiring).distiller();
    r.m.getAbstractFileByPath.mockReturnValueOnce(file("a.md"));
    expect(dep(captured.distill, "exists", "a.md")).toBe(true);
    r.m.getAbstractFileByPath.mockReturnValueOnce({ folder: true });
    expect(dep(captured.distill, "exists", "dir")).toBe(false);
    expect(dep(captured.distill, "exists", "none")).toBe(false);
  });

  it("resolves a link through the metadata cache, then a vault file path, else null", () => {
    const r = rig();
    buildChat(r.host, r.wiring).distiller();
    r.m.getFirstLinkpathDest.mockReturnValueOnce({ path: "Notes/a.md" });
    expect(dep(captured.distill, "resolveLink", "a.md")).toBe("Notes/a.md");
    expect(r.m.getFirstLinkpathDest).toHaveBeenCalledWith("a", "");
    r.m.getAbstractFileByPath.mockReturnValueOnce(file("b.md"));
    expect(dep(captured.distill, "resolveLink", "b.md")).toBe("b.md");
    expect(r.m.getAbstractFileByPath).toHaveBeenCalledWith("b.md");
    expect(dep(captured.distill, "resolveLink", "c.md")).toBeNull();
  });

  it("writes in place to an existing file, otherwise creates a summary note", async () => {
    const r = rig();
    buildChat(r.host, r.wiring).distiller();
    const existing = file("Chats/x.md");
    r.m.getAbstractFileByPath.mockReturnValueOnce(existing);
    await expect(dep(captured.distill, "write", "Chats/x.md", "Chats", "T", "content", "2026-01-01")).resolves.toBe("Chats/x.md");
    expect(r.m.modify).toHaveBeenCalledWith(existing, "content");
    expect(captured.saveSummaryNote).not.toHaveBeenCalled();
    expect(r.m.getAbstractFileByPath).toHaveBeenCalledTimes(1);
    expect(r.m.getAbstractFileByPath).toHaveBeenCalledWith("Chats/x.md");

    captured.saveSummaryNote.mockResolvedValue({ path: "Chats/new.md" });
    await expect(dep(captured.distill, "write", null, "Chats", "T", "content", "2026-01-01")).resolves.toBe("Chats/new.md");
    expect(r.m.getAbstractFileByPath).toHaveBeenCalledTimes(1);
    expect(captured.saveSummaryNote).toHaveBeenCalledWith(r.host.app, "Chats", "T", "content", "2026-01-01");
    expect(r.m.modify).toHaveBeenCalledTimes(1);

    r.m.getAbstractFileByPath.mockReturnValueOnce(null);
    await dep(captured.distill, "write", "gone.md", "Chats", "T", "content", "2026-01-01");
    expect(captured.saveSummaryNote).toHaveBeenCalledTimes(2);
  });

  it("forwards setDistilledNote, raises notices and reads host settings", () => {
    const r = rig();
    buildChat(r.host, r.wiring).distiller();
    dep(captured.distill, "setDistilledNote", "id", "p.md");
    expect(captured.setDistilledNote).toHaveBeenCalledWith("id", "p.md");
    dep(captured.distill, "notice", "hello");
    expect(getNoticeMessages()).toEqual(["hello"]);
    expect(dep(captured.distill, "settings")).toBe(r.settings);
  });
});

describe("buildChat sessionActions", () => {
  it("forwards find, archive, fork and createSeeded to the conversations controller", () => {
    const r = rig();
    captured.list.mockReturnValue([{ id: "a" }]);
    buildChat(r.host, r.wiring).sessionActions();
    expect(dep(captured.session, "find", "a")).toEqual({ id: "a" });
    dep(captured.session, "archive", "a");
    expect(captured.archive).toHaveBeenCalledWith("a");
    dep(captured.session, "fork", "a");
    expect(captured.fork).toHaveBeenCalledWith("a");
    dep(captured.session, "createSeeded", "T", "seed", "proj");
    expect(captured.createSeeded).toHaveBeenCalledWith("T", "seed", "proj");
  });

  it("distill forwards to the distiller", () => {
    const r = rig();
    captured.distillCall.mockReturnValue("distilled");
    buildChat(r.host, r.wiring).sessionActions();
    expect(dep(captured.session, "distill", "a")).toBe("distilled");
    expect(captured.distillCall).toHaveBeenCalledWith("a");
  });

  it("readNote returns the cached read for a TFile and null otherwise", async () => {
    const r = rig();
    buildChat(r.host, r.wiring).sessionActions();
    const f = file("a.md");
    r.m.getAbstractFileByPath.mockReturnValueOnce(f);
    await expect(dep(captured.session, "readNote", "a.md")).resolves.toBe("body");
    expect(r.m.cachedRead).toHaveBeenCalledWith(f);
    await expect(dep(captured.session, "readNote", "none.md")).resolves.toBeNull();
  });

  it("opens a conversation in a new tab and reveals the leaf", async () => {
    const r = rig();
    buildChat(r.host, r.wiring).sessionActions();
    await dep(captured.session, "openInNewTab", "c1");
    expect(r.m.getLeaf).toHaveBeenCalledWith("tab");
    expect(r.m.setViewState).toHaveBeenCalledWith({ type: "claude-companion-chat", active: true, state: { conversationId: "c1" } });
    expect(r.m.revealLeaf).toHaveBeenCalledWith(r.leaf);
    expect(r.m.setViewState.mock.invocationCallOrder[0]).toBeLessThan(r.m.revealLeaf.mock.invocationCallOrder[0]!);
  });
});

describe("buildChat turnService", () => {
  const done = { conversationId: "c1", title: "Title", result: { text: "answer", trace: [] } };

  it.each([false, true])("reports completion without a desktop toast (mobile: %s)", (mobile) => {
    Platform.isMobile = mobile;
    const r = rig();
    buildChat(r.host, r.wiring).turnService();
    captured.unattached!(done);
    expect(getNoticeMessages()).toEqual(mobile ? ["Claude finished: Title"] : []);
    expect(r.m.onUnattachedTurnDone).toHaveBeenCalledWith("c1", "Title");
  });

  it.each([false, true])("does nothing when notifications are off (mobile: %s)", (mobile) => {
    Platform.isMobile = mobile;
    const r = rig({ notify: false });
    buildChat(r.host, r.wiring).turnService();
    captured.unattached!(done);
    expect(getNoticeMessages()).toEqual([]);
    expect(r.m.onUnattachedTurnDone).not.toHaveBeenCalled();
  });
});

describe("buildChat memoization", () => {
  it("returns one instance per getter", () => {
    const r = rig();
    const chat = buildChat(r.host, r.wiring);
    expect(chat.conversations()).toBe(chat.conversations());
    expect(chat.distiller()).toBe(chat.distiller());
    expect(chat.sessionActions()).toBe(chat.sessionActions());
    expect(chat.turnService()).toBe(chat.turnService());
    expect(captured.counts).toEqual({ conversations: 1, distill: 1, session: 1, turn: 1 });
  });

  it("builds the distiller once when reached through sessionActions", () => {
    const r = rig();
    const chat = buildChat(r.host, r.wiring);
    chat.sessionActions();
    dep(captured.session, "distill", "a");
    dep(captured.session, "distill", "b");
    chat.distiller();
    expect(captured.counts.distill).toBe(1);
  });
});
