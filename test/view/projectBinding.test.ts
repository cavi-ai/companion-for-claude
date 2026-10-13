import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, EventRef } from "obsidian";
import { ChatProjectBinding, type ProjectBindingHost } from "../../src/view/chat/projectBinding";
import { ChatSession } from "../../src/view/chat/chatSession";
import type { ChatProject } from "../../src/projects/model";

type Handler = (...args: unknown[]) => void;

function project(id: string, name = id): ChatProject {
  return { id, name, folder: null, pinned: [], instructions: "", source: "note" };
}

interface RepoProject { path: string; status: string }

function rig() {
  const handlers = new Map<string, Handler>();
  const on = (scope: string) => (name: string, cb: Handler): EventRef => {
    handlers.set(`${scope}:${name}`, cb);
    return { scope, name } as unknown as EventRef;
  };
  const frontmatter: { value: Record<string, unknown> | undefined } = { value: undefined };
  const app = {
    vault: { on: on("vault") },
    metadataCache: { on: on("meta"), getFileCache: () => ({ frontmatter: frontmatter.value }) },
  } as unknown as App;
  const repo = {
    listProjects: vi.fn(async (): Promise<RepoProject[]> => []),
    loadProject: vi.fn(async (_path: string) => ({ claims: [] as { path: string; proposition: string; project: string }[] })),
  };
  const setProject = vi.fn(async () => undefined);
  const plugin = {
    research: () => ({ researchRepository: () => repo }),
    listChatProjects: vi.fn(async (): Promise<ChatProject[]> => []),
    chatProjectFor: vi.fn(async (_id: string | null): Promise<ChatProject | null> => null),
    conversations: () => ({ setProject }),
  } as unknown as ProjectBindingHost & { listChatProjects: ReturnType<typeof vi.fn>; chatProjectFor: ReturnType<typeof vi.fn> };
  const chat = new ChatSession({ writes: () => false, setWrites: vi.fn(), save: async () => undefined, notify: vi.fn() });
  const conversation: { id: string | null } = { id: null };
  const deps = {
    conversationId: vi.fn(() => conversation.id),
    showProject: vi.fn(),
    updateUsageBar: vi.fn(),
  };
  const binding = new ChatProjectBinding(app, plugin, chat, deps);
  const register = vi.fn();
  const fire = (key: string, ...args: unknown[]) => handlers.get(key)?.(...args);
  return { binding, plugin, repo, setProject, chat, deps, conversation, register, fire, frontmatter };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ChatProjectBinding.watch", () => {
  it("registers four refs and runs the initial reloads once", async () => {
    const r = rig();
    r.binding.watch(r.register);
    await flush();
    expect(r.register).toHaveBeenCalledTimes(4);
    expect(r.repo.listProjects).toHaveBeenCalledTimes(1);
    expect(r.plugin.listChatProjects).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid changes into one claims reload and ignores non-markdown creates", async () => {
    const r = rig();
    r.binding.watch(r.register);
    await flush();
    r.repo.listProjects.mockClear();
    r.fire("meta:changed", { path: "a.md" });
    r.fire("meta:changed", { path: "b.md" });
    r.fire("meta:changed", { path: "c.md" });
    await vi.advanceTimersByTimeAsync(499);
    expect(r.repo.listProjects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.repo.listProjects).toHaveBeenCalledTimes(1);
    r.fire("vault:create", { path: "image.png" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.repo.listProjects).toHaveBeenCalledTimes(1);
  });

  it("reloads projects only for project changes", async () => {
    const r = rig();
    r.binding.watch(r.register);
    await flush();
    r.plugin.listChatProjects.mockClear();
    r.fire("meta:changed", { path: "notes/plain.md" });
    await flush();
    expect(r.plugin.listChatProjects).not.toHaveBeenCalled();
    r.frontmatter.value = { type: "chat-project" };
    r.fire("meta:changed", { path: "notes/proj.md" });
    await flush();
    expect(r.plugin.listChatProjects).toHaveBeenCalledTimes(1);
    r.frontmatter.value = undefined;
    r.fire("vault:rename", { path: "notes/x.md" }, "R/Project.md");
    await flush();
    expect(r.plugin.listChatProjects).toHaveBeenCalledTimes(2);
    r.fire("vault:rename", { path: "R/Project.md" }, "notes/x.md");
    await flush();
    expect(r.plugin.listChatProjects).toHaveBeenCalledTimes(3);
    r.fire("vault:rename", { path: "notes/y.md" }, "notes/x.md");
    await flush();
    expect(r.plugin.listChatProjects).toHaveBeenCalledTimes(3);
  });
});

describe("ChatProjectBinding reloads", () => {
  it("collects claims from active research projects only", async () => {
    const r = rig();
    r.repo.listProjects.mockResolvedValue([{ path: "A/Project.md", status: "active" }, { path: "B/Project.md", status: "archived" }]);
    r.repo.loadProject.mockImplementation(async (path: string) => ({ claims: [{ path: `${path}#c`, proposition: `claim of ${path}`, project: path }] }));
    r.binding.watch(r.register);
    await flush();
    expect(r.repo.loadProject).toHaveBeenCalledTimes(1);
    expect(r.binding.claims()).toEqual([{ path: "A/Project.md#c", label: "claim of A/Project.md", project: "A/Project.md" }]);
  });

  it("drops the result of an older reload that finishes after a newer one", async () => {
    const r = rig();
    let releaseFirst: (v: RepoProject[]) => void = () => undefined;
    r.repo.listProjects
      .mockImplementationOnce(() => new Promise<RepoProject[]>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue([{ path: "New/Project.md", status: "active" }]);
    r.repo.loadProject.mockImplementation(async (path: string) => ({ claims: [{ path, proposition: path, project: path }] }));
    r.binding.watch(r.register);
    r.fire("meta:changed", { path: "a.md" });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.binding.claims().map((c) => c.project)).toEqual(["New/Project.md"]);
    releaseFirst([{ path: "Old/Project.md", status: "active" }]);
    await flush();
    expect(r.binding.claims().map((c) => c.project)).toEqual(["New/Project.md"]);
  });

  it("leaves the list untouched when the repository throws", async () => {
    const r = rig();
    r.repo.listProjects.mockResolvedValueOnce([{ path: "A/Project.md", status: "active" }]);
    r.repo.loadProject.mockResolvedValue({ claims: [{ path: "p", proposition: "x", project: "A/Project.md" }] });
    r.binding.watch(r.register);
    await flush();
    expect(r.binding.claims()).toHaveLength(1);
    r.repo.listProjects.mockRejectedValue(new Error("down"));
    r.fire("meta:changed", { path: "a.md" });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.binding.claims()).toHaveLength(0);
  });

  it("keeps the previous project list when listing rejects and maps options to id and name", async () => {
    const r = rig();
    r.plugin.listChatProjects.mockResolvedValueOnce([project("a.md", "Alpha")]);
    r.binding.watch(r.register);
    await flush();
    expect(r.binding.projectOptions()).toEqual([{ id: "a.md", name: "Alpha" }]);
    r.plugin.listChatProjects.mockRejectedValue(new Error("down"));
    r.frontmatter.value = { type: "chat-project" };
    r.fire("meta:changed", { path: "x.md" });
    await flush();
    expect(r.binding.projectOptions()).toEqual([{ id: "a.md", name: "Alpha" }]);
  });
});

describe("ChatProjectBinding project choice", () => {
  it("holds the choice as pending when there is no conversation", async () => {
    const r = rig();
    const p = project("a.md", "Alpha");
    await r.binding.applyChosen(p);
    expect(r.setProject).not.toHaveBeenCalled();
    expect(r.deps.showProject).toHaveBeenCalledWith(p);
    expect(r.chat.project).toBe(p);
    r.conversation.id = "c1";
    await r.binding.bindPending("c1");
    expect(r.setProject).toHaveBeenCalledWith("c1", "a.md");
  });

  it("persists the choice on an open conversation, then refreshes and updates usage", async () => {
    const r = rig();
    r.conversation.id = "c1";
    const p = project("a.md");
    r.plugin.chatProjectFor.mockResolvedValue(p);
    await r.binding.applyChosen(p);
    expect(r.setProject).toHaveBeenCalledWith("c1", "a.md");
    expect(r.plugin.chatProjectFor).toHaveBeenCalledWith("c1");
    expect(r.deps.showProject).toHaveBeenCalledWith(p);
    expect(r.deps.updateUsageBar).toHaveBeenCalledTimes(1);
  });

  it("clears the project by id, with or without a conversation", async () => {
    const r = rig();
    r.conversation.id = "c1";
    r.binding.chooseById(null);
    await flush();
    expect(r.setProject).toHaveBeenCalledWith("c1", null);
    expect(r.plugin.chatProjectFor).toHaveBeenCalledWith("c1");
    expect(r.deps.updateUsageBar).toHaveBeenCalledTimes(1);

    const s = rig();
    await s.binding.applyChosen(project("a.md"));
    s.binding.chooseById(null);
    await flush();
    expect(s.deps.showProject).toHaveBeenLastCalledWith(null);
    expect(s.setProject).not.toHaveBeenCalled();
    s.conversation.id = "c2";
    await s.binding.bindPending("c2");
    expect(s.setProject).not.toHaveBeenCalled();
  });

  it("ignores an unknown id and applies a known one", async () => {
    const r = rig();
    r.conversation.id = "c1";
    r.plugin.listChatProjects.mockResolvedValue([project("a.md", "Alpha")]);
    r.binding.watch(r.register);
    await flush();
    r.binding.chooseById("missing.md");
    await flush();
    expect(r.setProject).not.toHaveBeenCalled();
    r.binding.chooseById("a.md");
    await flush();
    expect(r.setProject).toHaveBeenCalledWith("c1", "a.md");
  });

  it("binds a pending project once", async () => {
    const r = rig();
    await r.binding.applyChosen(project("a.md"));
    await r.binding.bindPending("c1");
    await r.binding.bindPending("c1");
    expect(r.setProject).toHaveBeenCalledTimes(1);
    expect(r.setProject).toHaveBeenCalledWith("c1", "a.md");
  });

  it("forget drops the pending choice and clear also resets the shown project", async () => {
    const r = rig();
    await r.binding.applyChosen(project("a.md"));
    r.binding.forget();
    await r.binding.bindPending("c1");
    expect(r.setProject).not.toHaveBeenCalled();
    r.binding.clear();
    expect(r.chat.project).toBeNull();
    expect(r.deps.showProject).toHaveBeenLastCalledWith(null);
  });
});

describe("ChatProjectBinding.dispose", () => {
  it("cancels a scheduled reload and invalidates one in flight", async () => {
    const r = rig();
    r.binding.watch(r.register);
    await flush();
    r.repo.listProjects.mockClear();
    r.fire("meta:changed", { path: "a.md" });
    r.binding.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.repo.listProjects).not.toHaveBeenCalled();

    const s = rig();
    let release: (v: RepoProject[]) => void = () => undefined;
    s.repo.listProjects.mockImplementationOnce(() => new Promise<RepoProject[]>((resolve) => { release = resolve; }));
    s.repo.loadProject.mockResolvedValue({ claims: [{ path: "p", proposition: "x", project: "A/Project.md" }] });
    s.binding.watch(s.register);
    s.binding.dispose();
    release([{ path: "A/Project.md", status: "active" }]);
    await flush();
    expect(s.binding.claims()).toEqual([]);
  });
});
